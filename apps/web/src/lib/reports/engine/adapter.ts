/**
 * Report engine — DB ADAPTER (server only). The single I/O boundary between the caller's
 * RLS-scoped Supabase client and the pure core (plan → build). Reference reads run AS THE
 * CALLER (org isolation + client-scope RLS); the requested companies are validated against
 * the caller's client scope (AC3A.15) before anything is read.
 *
 * The three governed RPCs (report_balances, report_drill_lines, period_balances_tieout) are
 * not executable by members: they run on the SERVICE ROLE (./service-client.ts), always
 * with p_org = the caller's org and an explicit, non-empty, scope-checked company list —
 * never null (null = every company in the org under the service role) — and only after the
 * route's permission check and, for drills, the governance gate.
 *
 * Reads:
 *   - public.report_balances (mig 185) — one jsonb round-trip, never row-capped;
 *   - accounts (+ group / sub-type / type), account_roles, core.locations, dimensions;
 *   - budgets (013) for budget / forecast comparisons;
 *   - reporting_basis_adjustments (147) for TAX / CUSTOM; the live cash conversion for CASH;
 *   - fiscal_periods for column status + forecast actualisation;
 *   - entity_ownership (076) via loadOwnership for consolidation;
 *   - report_layouts (185) for custom layouts.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
// Installs 3D number governance (release cut-off, restatements, in-group windows) into the
// engine's call points — every engine result is governed wherever the engine runs.
import '@/lib/reports/governance';
import { fetchAll } from '@/lib/supabase/fetch-all';
import { decideClientScope, loadClientScope, logClientScopeDenials, type ClientScopeState } from '@/lib/rbac/client-scope';
import { buildReport } from './build';
import { planReport, type Plan } from './plan';
import { basisKey } from './aggregate';
import { applyGovernance, governDrill, resolveMembership } from './governance-hook';
import { engineServiceClient } from './service-client';
import { addDays, monthStart, monthsIn, rangeKey } from './periods';
import type {
  AccountMeta,
  AccountType,
  BalanceRow,
  BasisDelta,
  BudgetRow,
  CompanyMeta,
  CustomLayout,
  DateRange,
  DimensionKey,
  DimensionMeta,
  DrillLine,
  DrillRequest,
  DrillResult,
  EngineData,
  EntryKind,
  LayoutRowDef,
  OwnershipMeta,
  PeriodStatusRow,
  ReportRequest,
  ReportResult,
} from './types';

export interface EngineContext {
  /** the caller's RLS-scoped client (ApiContext.supabase) */
  supabase: SupabaseClient;
  orgId: string;
  userId: string | null;
  /**
   * The service-role client for the governed RPCs (tests inject a harness client). Default:
   * createAdminSupabase(). Used ONLY for report_balances / report_drill_lines /
   * period_balances_tieout, with p_org and a scope-checked company list.
   */
  service?: SupabaseClient | null;
}

export class EngineScopeError extends Error {
  readonly status = 403;
  constructor(readonly companyIds: string[]) {
    super('One or more companies are outside your client access.');
  }
}

export class EngineInputError extends Error {
  readonly status = 422;
}

const N = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

// ─── reference data ──────────────────────────────────────────────────────────

/**
 * Accounts with their group / sub-type / type ordering and normal balance. Four plain reads
 * stitched in JS (no PostgREST embeds) so the same code runs against any client.
 */
export async function loadAccounts(supabase: SupabaseClient): Promise<AccountMeta[]> {
  const [acc, groups, subs, types, roles] = await Promise.all([
    fetchAll(() => supabase.from('accounts').select('id, account_number, name, account_type, account_sub_type, is_active, is_bank_account, is_eliminating, display_order, cash_flow_category, account_group_id'), { label: 'engine accounts' }),
    fetchAll(() => supabase.from('account_groups').select('id, name, display_order, account_sub_type_id'), { label: 'engine account_groups' }),
    fetchAll(() => supabase.from('account_sub_types').select('id, name, code, display_order, account_type_id'), { label: 'engine account_sub_types' }),
    fetchAll(() => supabase.from('account_types').select('id, code, normal_balance, display_order'), { label: 'engine account_types' }),
    fetchAll(() => supabase.from('account_roles').select('id, account_id, role_key'), { label: 'engine account_roles' }),
  ]);
  for (const r of [acc, groups, subs, types]) if (r.error) throw new Error(r.error.message);
  const roleMap = new Map<string, string[]>();
  for (const r of (roles.data ?? []) as Array<{ account_id: string; role_key: string }>) {
    const list = roleMap.get(r.account_id) ?? [];
    if (!list.includes(r.role_key)) list.push(r.role_key);
    roleMap.set(r.account_id, list);
  }
  const groupById = new Map(((groups.data ?? []) as Array<Record<string, unknown>>).map((g) => [String(g.id), g]));
  const subById = new Map(((subs.data ?? []) as Array<Record<string, unknown>>).map((x) => [String(x.id), x]));
  const typeById = new Map(((types.data ?? []) as Array<Record<string, unknown>>).map((x) => [String(x.id), x]));
  const typeByCode = new Map(((types.data ?? []) as Array<Record<string, unknown>>).map((x) => [String(x.code), x]));
  return ((acc.data ?? []) as Array<Record<string, unknown>>).map((a) => {
    const g = groupById.get(String(a.account_group_id)) ?? {};
    const st = subById.get(String((g as Record<string, unknown>).account_sub_type_id)) ?? {};
    const type = String(a.account_type) as AccountType;
    const t = typeById.get(String((st as Record<string, unknown>).account_type_id)) ?? typeByCode.get(type) ?? {};
    const nb = (t as Record<string, unknown>).normal_balance;
    const cfc = a.cash_flow_category as AccountMeta['cashFlowCategory'];
    return {
      id: String(a.id),
      number: String(a.account_number ?? ''),
      name: String(a.name ?? ''),
      type,
      subType: String(a.account_sub_type ?? ''),
      subTypeName: String((st as Record<string, unknown>).name ?? ''),
      subTypeOrder: N((st as Record<string, unknown>).display_order),
      groupId: String(a.account_group_id ?? ''),
      groupName: String((g as Record<string, unknown>).name ?? 'Ungrouped'),
      groupOrder: N((g as Record<string, unknown>).display_order),
      order: N(a.display_order),
      normalBalance: nb === 'CREDIT' ? 'CREDIT' : nb === 'DEBIT' ? 'DEBIT' : (type === 'LIABILITY' || type === 'EQUITY' || type === 'REVENUE' ? 'CREDIT' : 'DEBIT'),
      isBank: a.is_bank_account === true,
      isEliminating: a.is_eliminating === true,
      isActive: a.is_active !== false,
      roles: roleMap.get(String(a.id)) ?? [],
      cashFlowCategory: cfc ?? null,
    } satisfies AccountMeta;
  });
}

export async function loadCompanies(supabase: SupabaseClient, orgId?: string | null): Promise<CompanyMeta[]> {
  let q = supabase
    .schema('core')
    .from('locations')
    .select('id, name, short_code, fiscal_year_start_month, is_active');
  // Pin the org too (RLS already does for a member; this keeps a service caller honest).
  if (orgId) q = q.eq('org_id', orgId);
  const { data, error } = await q.order('name');
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<Record<string, unknown>>)
    .filter((l) => l.is_active !== false)
    .map((l) => ({ id: String(l.id), name: String(l.name ?? ''), shortCode: (l.short_code as string) ?? null, fiscalYearStartMonth: N(l.fiscal_year_start_month) || 1 }));
}

async function loadOrgFyStart(supabase: SupabaseClient, orgId: string): Promise<{ fy: number; tz: string | null }> {
  const { data } = await supabase.schema('core').from('organizations').select('fiscal_year_start_month, timezone').eq('id', orgId).maybeSingle();
  const row = (data ?? {}) as Record<string, unknown>;
  return { fy: N(row.fiscal_year_start_month) || 1, tz: (row.timezone as string) ?? null };
}

async function loadDimensions(supabase: SupabaseClient, keys: DimensionKey[]): Promise<Partial<Record<DimensionKey, DimensionMeta[]>>> {
  const out: Partial<Record<DimensionKey, DimensionMeta[]>> = {};
  await Promise.all(
    keys.map(async (k) => {
      if (k === 'department') {
        const { data } = await supabase.schema('core').from('departments').select('id, name, code, is_active').order('name');
        out.department = ((data ?? []) as Array<Record<string, unknown>>).filter((d) => d.is_active !== false).map((d) => ({ id: String(d.id), name: String(d.name), code: (d.code as string) ?? null }));
      } else if (k === 'class') {
        const { data } = await supabase.from('classes').select('id, name, code, is_active').order('name');
        out.class = ((data ?? []) as Array<Record<string, unknown>>).filter((d) => d.is_active !== false).map((d) => ({ id: String(d.id), name: String(d.name), code: (d.code as string) ?? null }));
      } else if (k === 'job') {
        const { data } = await fetchAll(() => supabase.schema('core').from('jobs').select('id, job_number, name'), { label: 'engine jobs' });
        out.job = ((data ?? []) as Array<Record<string, unknown>>).map((d) => ({ id: String(d.id), name: [d.job_number, d.name].filter(Boolean).join(' · '), code: (d.job_number as string) ?? null }));
      } else if (k === 'item') {
        const { data } = await fetchAll(() => supabase.schema('core').from('items').select('id, name, sku'), { label: 'engine items' });
        out.item = ((data ?? []) as Array<Record<string, unknown>>).map((d) => ({ id: String(d.id), name: String(d.name ?? d.sku ?? d.id), code: (d.sku as string) ?? null }));
      }
    }),
  );
  return out;
}

// ─── client scope ────────────────────────────────────────────────────────────

/**
 * Resolve the companies a request may include. An explicitly requested company that is not
 * visible or not in the caller's scope is REFUSED (enforce) — never silently dropped, so a
 * statement can never claim to cover a company it does not. "All" = every visible company
 * in scope.
 */
export async function resolveCompanies(
  ctx: EngineContext,
  requested: string[],
  companies: CompanyMeta[],
  state?: ClientScopeState,
): Promise<string[]> {
  const s = state ?? (await loadClientScope({ supabase: ctx.supabase }));
  const visible = new Set(companies.map((c) => c.id));
  if (requested.length === 0) {
    const ids = companies.map((c) => c.id);
    const out = ids.filter((id) => decideClientScope(s, id).allowed);
    await logClientScopeDenials({ supabase: ctx.supabase }, s, ids, 'api', { surface: 'report_engine' });
    return out;
  }
  const unique = [...new Set(requested)];
  const denied = unique.filter((id) => !visible.has(id) || !decideClientScope(s, id).allowed);
  await logClientScopeDenials({ supabase: ctx.supabase }, s, unique, 'api', { surface: 'report_engine' });
  if (denied.length) throw new EngineScopeError(denied);
  return unique;
}

// ─── balances ────────────────────────────────────────────────────────────────

type RawRow = [string, string, string | null, string, string | null, string | null, string | null, string | null, string | null, number | string, number | string];

export function parseBalanceRows(raw: unknown): BalanceRow[] {
  const doc = (raw ?? {}) as { rows?: RawRow[] };
  return (doc.rows ?? []).map((r) => ({
    companyId: r[0],
    accountId: r[1],
    period: r[2] ? String(r[2]).slice(0, 10) : null,
    kind: (r[3] as EntryKind) ?? 'STANDARD',
    departmentId: r[4] ?? null,
    classId: r[5] ?? null,
    jobId: r[6] ?? null,
    itemId: r[7] ?? null,
    counterpartyId: r[8] ?? null,
    debit: N(r[9]),
    credit: N(r[10]),
  }));
}

/**
 * True when an error says the balances store / its read RPC is not deployed in this database
 * (consumers with a ledger fallback — metrics, flux — use it to degrade instead of failing).
 */
export function isStoreUnavailable(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  if (!/report_balances|period_balances/.test(msg)) return false;
  return /does not exist|could not find the function|schema cache|PGRST202|42883/i.test(msg);
}

/** Every governed RPC call needs an explicit company list — never null / empty (= all). */
function requireCompanies(ids: readonly string[]): string[] {
  const out = Array.from(new Set(ids.filter((x) => typeof x === 'string' && x.length > 0)));
  if (out.length === 0) throw new EngineInputError('No companies are available to report on.');
  return out;
}

/** report_balances on the service role, for companies ALREADY checked against the caller's scope. */
async function rpcBalances(
  service: SupabaseClient,
  orgId: string,
  companyIds: readonly string[],
  opts: { from: string | null; to: string; dims?: Array<DimensionKey | 'counterparty'>; opening?: boolean },
): Promise<BalanceRow[]> {
  if (!orgId) throw new EngineInputError('No organization.');
  const { data, error } = await service.rpc('report_balances', {
    p_location_ids: requireCompanies(companyIds),
    p_from: opts.from,
    p_to: opts.to,
    p_dims: opts.dims ?? [],
    p_opening: opts.opening ?? false,
    p_org: orgId,
  });
  if (error) throw new Error(`report_balances: ${error.message}`);
  return parseBalanceRows(data);
}

/**
 * The companies a caller may read balances for: `requested` (each must be visible in the
 * org AND in the caller's client scope — else EngineScopeError), or every in-scope company
 * when empty. Never returns an empty list (EngineInputError).
 */
export async function assertScopedCompanies(caller: SupabaseClient, orgId: string, requested: readonly string[]): Promise<string[]> {
  const companies = await loadCompanies(caller, orgId);
  return requireCompanies(await resolveCompanies({ supabase: caller, orgId, userId: null }, [...requested], companies));
}

/**
 * 3B / 3E entry point: balances for companies × months (+ opening bucket). The companies are
 * checked against the CALLER's client scope (`supabase` = the caller's RLS client) before the
 * service-role read; an empty list means every company in scope (never "every company").
 */
export async function loadBalances(
  supabase: SupabaseClient,
  orgId: string,
  opts: { companyIds: string[]; from: string | null; to: string; dims?: Array<DimensionKey | 'counterparty'>; opening?: boolean },
  service?: SupabaseClient | null,
): Promise<BalanceRow[]> {
  const ids = await assertScopedCompanies(supabase, orgId, opts.companyIds);
  return rpcBalances(engineServiceClient(service), orgId, ids, opts);
}

// ─── budgets / basis / period status ─────────────────────────────────────────

function yearsBetween(from: string, to: string): number[] {
  const out: number[] = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) out.push(y);
  return out;
}

async function loadBudgets(supabase: SupabaseClient, companyIds: string[], from: string, to: string): Promise<BudgetRow[]> {
  const years = yearsBetween(from, to);
  const { data, error } = await fetchAll(
    () => {
      let q = supabase.from('budgets').select('id, location_id, account_id, department_id, fiscal_year, period_number, amount_cents').in('fiscal_year', years);
      if (companyIds.length) q = q.in('location_id', companyIds);
      return q;
    },
    { label: 'engine budgets' },
  );
  if (error) throw new Error(error.message);
  const out: BudgetRow[] = [];
  for (const b of (data ?? []) as Array<Record<string, unknown>>) {
    const pn = N(b.period_number);
    if (pn < 1 || pn > 12) continue; // period 13 (adjustments) has no calendar month
    out.push({
      companyId: String(b.location_id),
      accountId: String(b.account_id),
      departmentId: (b.department_id as string) ?? null,
      period: `${N(b.fiscal_year)}-${String(pn).padStart(2, '0')}-01`,
      naturalCents: N(b.amount_cents),
    });
  }
  return out;
}

async function loadStoredBasis(
  supabase: SupabaseClient,
  basis: 'TAX' | 'CUSTOM',
  customLabel: string | null | undefined,
  from: string,
  to: string,
  fyStartMonth: number,
): Promise<BasisDelta[]> {
  const years = yearsBetween(from, to);
  years.push(years[years.length - 1] + 1);
  const { data, error } = await fetchAll(
    () => {
      let q = supabase
        .from('reporting_basis_adjustments')
        .select('id, location_id, basis, custom_label, period_year, period_month, account_id, amount_cents, description')
        .eq('basis', basis)
        .in('period_year', years);
      if (basis === 'CUSTOM' && customLabel) q = q.eq('custom_label', customLabel);
      return q;
    },
    { label: 'engine basis adjustments' },
  );
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
    const y = N(r.period_year);
    const m = r.period_month == null ? null : N(r.period_month);
    // whole-year adjustments are pinned to the fiscal year's last month
    const lastFyMonth = ((fyStartMonth + 10) % 12) + 1;
    const period = m ? `${y}-${String(m).padStart(2, '0')}-01` : `${y}-${String(lastFyMonth).padStart(2, '0')}-01`;
    return { accountId: String(r.account_id), companyId: (r.location_id as string) ?? null, period, naturalCents: N(r.amount_cents), description: (r.description as string) ?? null };
  });
}

/** Live accrual→cash deltas for one P&L cell (same conversion as /api/basis-adjustments/cash). */
async function cashDeltas(supabase: SupabaseClient, orgId: string, range: DateRange, companyIds: string[]): Promise<BasisDelta[]> {
  if (!range.start) return [];
  const [{ fetchIncomeStatement }, { fetchCashIncomeStatement }, { deriveCashAdjustments }] = await Promise.all([
    import('@/app/api/reports/board-package/queries'),
    import('@/lib/reports/income-statement-cash'),
    import('@/lib/reports/basis/derive-cash'),
  ]);
  const scope = { startDate: range.start, endDate: range.end, locationIds: companyIds };
  const [accrual, cash] = await Promise.all([
    fetchIncomeStatement(supabase, { ...scope, basis: 'accrual' }),
    fetchCashIncomeStatement(supabase, orgId, scope),
  ]);
  const flat = (p: typeof accrual) =>
    p.sections.flatMap((sec) =>
      sec.groups.flatMap((g) =>
        g.accounts
          .filter((a) => !!a.accountId)
          .map((a) => ({ accountId: a.accountId as string, accountNumber: a.accountNumber, normalBalance: (sec.type === 'REVENUE' || sec.type === 'OTHER' ? 'CREDIT' : 'DEBIT') as 'CREDIT' | 'DEBIT', naturalCents: a.amountCents })),
      ),
    );
  const { data: re } = await supabase.from('account_roles').select('account_id').eq('role_key', 'RETAINED_EARNINGS').is('location_id', null).maybeSingle();
  const derived = deriveCashAdjustments(flat(accrual), flat(cash), (re?.account_id as string) ?? null);
  return derived.adjustments.map((a) => ({ accountId: a.accountId, companyId: null, period: monthStart(range.end), naturalCents: a.amountCents, description: a.description ?? null }));
}

async function loadPeriodStatus(supabase: SupabaseClient, companyIds: string[], from: string, to: string): Promise<PeriodStatusRow[]> {
  const { data, error } = await fetchAll(
    () => {
      let q = supabase.from('fiscal_periods').select('id, location_id, start_date, status').gte('start_date', monthStart(from)).lte('start_date', to);
      if (companyIds.length) q = q.in('location_id', companyIds);
      return q;
    },
    { label: 'engine fiscal_periods' },
  );
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<Record<string, unknown>>).map((p) => ({
    companyId: String(p.location_id),
    period: String(p.start_date).slice(0, 10),
    status: (p.status as PeriodStatusRow['status']) ?? 'OPEN',
  }));
}

async function loadAccumulatedDepreciation(supabase: SupabaseClient): Promise<string[]> {
  const { data } = await fetchAll(() => supabase.from('fixed_assets').select('id, accumulated_depreciation_account_id'), { label: 'engine fixed_assets' });
  return [...new Set(((data ?? []) as Array<Record<string, unknown>>).map((r) => r.accumulated_depreciation_account_id as string).filter(Boolean))];
}

export async function loadLayout(supabase: SupabaseClient, id: string): Promise<CustomLayout | null> {
  const { data, error } = await supabase.from('report_layouts').select('id, name, statement, rows, is_archived').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || (data as Record<string, unknown>).is_archived === true) return null;
  const r = data as Record<string, unknown>;
  return { id: String(r.id), name: String(r.name), statement: r.statement === 'BS' ? 'BS' : 'PNL', rows: (r.rows ?? []) as LayoutRowDef[] };
}

async function loadOwnershipMeta(supabase: SupabaseClient, orgId: string, asOf: string): Promise<OwnershipMeta[]> {
  try {
    const { loadOwnership } = await import('@/lib/consolidation/load');
    const res = await loadOwnership(supabase, orgId, asOf);
    return res.entityMeta.map((e) => ({ entityId: e.entityId, method: e.method, ownershipPercent: e.ownershipPercent }));
  } catch {
    return []; // degrade: everyone FULL / 100%
  }
}

function todayIn(tz: string | null): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// ─── run ─────────────────────────────────────────────────────────────────────

/** Cash-basis cells are expensive (a live conversion each) — cap and warn beyond this. */
export const MAX_CASH_BASIS_CELLS = 8;

export interface LoadedReport {
  plan: Plan;
  data: EngineData;
  /** the requested custom layout is gone (archived / deleted) — the standard layout was used */
  layoutFallback: boolean;
}

export async function loadReportData(ctx: EngineContext, req: ReportRequest): Promise<LoadedReport> {
  const { supabase, orgId } = ctx;
  const [accounts, companies, org] = await Promise.all([loadAccounts(supabase), loadCompanies(supabase, orgId), loadOrgFyStart(supabase, orgId)]);
  // Scope check BEFORE any balance is read; the list is explicit and non-empty from here on.
  const companyIds = requireCompanies(await resolveCompanies(ctx, req.scope.companyIds, companies));
  const service = engineServiceClient(ctx.service);
  const dimKeys = new Set<DimensionKey>();
  const mode = req.columns;
  if (mode === 'department' || mode === 'class' || mode === 'job') dimKeys.add(mode);
  const dimensions = await loadDimensions(supabase, [...dimKeys]);
  const plan = planReport(req, { companies, companyIds, orgFiscalYearStartMonth: org.fy, dimensions });
  const f = plan.fetch;
  const scopeIds = companyIds;
  const [mainRows, exactSets, budgets, periodStatus, accumulatedDepreciationIds, customLayout, ownership] = await Promise.all([
    rpcBalances(service, orgId, scopeIds, { from: f.from, to: f.to, dims: f.dims, opening: true }),
    Promise.all(
      f.exactRanges.map(async (r) => [rangeKey(r), await rpcBalances(service, orgId, scopeIds, { from: r.start, to: r.end, dims: f.dims, opening: false })] as const),
    ),
    f.needsBudget ? loadBudgets(supabase, scopeIds, f.from, f.to) : Promise.resolve([] as BudgetRow[]),
    loadPeriodStatus(supabase, scopeIds, f.from, f.to),
    req.statement === 'cash_flow' ? loadAccumulatedDepreciation(supabase) : Promise.resolve([] as string[]),
    req.layout?.kind === 'custom' ? loadLayout(supabase, req.layout.layoutId) : Promise.resolve(null),
    plan.consolidated ? loadOwnershipMeta(supabase, orgId, plan.range.end) : Promise.resolve([] as OwnershipMeta[]),
  ]);
  let basisDeltas: BasisDelta[] = [];
  const basisDeltasByCell: Record<string, BasisDelta[]> = {};
  if (req.basis === 'TAX' || req.basis === 'CUSTOM') {
    basisDeltas = await loadStoredBasis(supabase, req.basis, req.customBasisLabel, f.from, f.to, plan.fyStartMonth);
  } else if (req.basis === 'CASH') {
    const cells = f.cashBasisCells.slice(0, MAX_CASH_BASIS_CELLS);
    const results = await Promise.all(cells.map((cell) => cashDeltas(supabase, orgId, cell.range, cell.companyIds)));
    cells.forEach((cell, i) => (basisDeltasByCell[basisKey(cell.range, cell.companyIds)] = results[i]));
  }
  const data: EngineData = {
    orgFiscalYearStartMonth: org.fy,
    accounts,
    companies,
    companyIds,
    balances: mainRows,
    exactBalances: Object.fromEntries(exactSets),
    budgets,
    basisDeltas,
    basisDeltasByCell,
    periodStatus,
    dimensions,
    ownership,
    accumulatedDepreciationIds,
    customLayout,
    today: todayIn(org.tz),
  };
  return { plan, data, layoutFallback: req.layout?.kind === 'custom' && !customLayout };
}

/** Every month a plan reads (the opening month before `from` included), 'YYYY-MM'. */
export function planMonths(plan: Plan): string[] {
  const from = monthStart(addDays(plan.fetch.from, -1));
  return monthsIn({ start: from, end: plan.fetch.to }).map((m) => m.slice(0, 7));
}

/** Run a report end-to-end: scope → plan → load → membership → build → governance. */
export async function runReport(ctx: EngineContext, req: ReportRequest): Promise<ReportResult> {
  const { plan, data: loaded, layoutFallback } = await loadReportData(ctx, req);
  const windowed = req.statement !== 'trial_balance' && req.statement !== 'gl_summary';
  const groupWindows = windowed ? await resolveMembership(
    { months: planMonths(plan), companyIds: loaded.companyIds, scopeKind: plan.consolidated ? 'consolidated' : loaded.companyIds.length > 1 ? 'combined' : 'company' },
    { supabase: ctx.supabase, orgId: ctx.orgId, userId: ctx.userId, request: req },
  ) : null;
  const data: EngineData = groupWindows ? { ...loaded, groupWindows } : loaded;
  const effective: ReportRequest = layoutFallback ? { ...req, layout: { kind: 'standard' } } : req;
  const result = buildReport(effective, plan, data);
  if (layoutFallback) result.warnings.unshift({ code: 'UNMAPPED_ACCOUNTS', message: 'The custom layout for this view was archived — showing the standard layout.' });
  if (req.basis === 'CASH' && plan.fetch.cashBasisCells.length > MAX_CASH_BASIS_CELLS) {
    result.warnings.push({ code: 'BASIS_LIMITED', message: `Cash basis is computed for the first ${MAX_CASH_BASIS_CELLS} columns; narrow the columns to see cash basis everywhere.` });
  }
  return applyGovernance(result, { supabase: ctx.supabase, orgId: ctx.orgId, userId: ctx.userId, request: req });
}

// ─── drill ───────────────────────────────────────────────────────────────────

export function sourceLink(module: string | null, id: string | null): { href: string; label: string } | null {
  if (!module || !id) return null;
  switch (module) {
    case 'BILL': return { href: `/bills?id=${id}`, label: 'Bill' };
    case 'AR':
    case 'INVOICE': return { href: `/invoices?invoice=${id}`, label: 'Invoice' };
    case 'BANK_FEED': return { href: `/bank-feed?txn=${id}`, label: 'Bank transaction' };
    case 'RECEIPT': return { href: `/receipts?id=${id}`, label: 'Receipt' };
    case 'PAYROLL': return { href: `/payroll?run=${id}`, label: 'Payroll run' };
    case 'INTERNAL_INVOICE':
    case 'INTERCOMPANY': return { href: `/internal-invoices?highlight=${id}`, label: 'Internal invoice' };
    default: return null;
  }
}

/**
 * The GL lines behind one cell. Order: client scope (refuse out-of-scope companies) →
 * governance (every month of the range released for the caller, else 403 NOT_RELEASED; the
 * in-group windows are computed server-side — client windows can only narrow) → the
 * service-role drill RPC with p_org and the explicit company list.
 */
export async function runDrill(ctx: EngineContext, req: DrillRequest): Promise<DrillResult> {
  if (req.range.start && req.range.start > req.range.end) throw new EngineInputError('The drill range starts after it ends.');
  const companies = await loadCompanies(ctx.supabase, ctx.orgId);
  const companyIds = requireCompanies(await resolveCompanies(ctx, req.companyIds, companies));
  const windows = await governDrill(
    { companyIds, range: req.range, windows: req.windows ?? null },
    { supabase: ctx.supabase, orgId: ctx.orgId, userId: ctx.userId },
  );
  const limit = Math.min(Math.max(req.limit ?? 100, 1), 1000);
  const offset = Math.max(req.offset ?? 0, 0);
  const { windows: _clientWindows, ...dims } = (req.dims ?? {}) as Record<string, unknown>;
  const { data, error } = await engineServiceClient(ctx.service).rpc('report_drill_lines', {
    p_account_ids: req.accountIds,
    p_location_ids: companyIds,
    p_from: req.range.start,
    p_to: req.range.end,
    p_dims: { ...dims, ...(windows && Object.keys(windows).length ? { windows } : {}) },
    p_kinds: req.kinds ?? ['STANDARD', 'ADJUSTING', 'CLOSING'],
    p_limit: limit,
    p_offset: offset,
    p_org: ctx.orgId,
  });
  if (error) throw new Error(`report_drill_lines: ${error.message}`);
  const doc = (data ?? {}) as { total_count?: number; debit_cents?: number; credit_cents?: number; rows?: Array<Record<string, unknown>> };
  const lines: DrillLine[] = (doc.rows ?? []).map((r) => {
    const src = sourceLink((r.source_module as string) ?? null, (r.source_id as string) ?? null);
    return {
      lineId: String(r.line_id),
      entryId: String(r.entry_id),
      entryNumber: String(r.entry_number ?? ''),
      entryDate: String(r.entry_date ?? '').slice(0, 10),
      entryType: String(r.entry_type ?? ''),
      memo: (r.memo as string) ?? null,
      sourceModule: (r.source_module as string) ?? null,
      sourceId: (r.source_id as string) ?? null,
      companyId: String(r.location_id),
      accountId: String(r.account_id),
      departmentId: (r.department_id as string) ?? null,
      classId: (r.class_id as string) ?? null,
      jobId: (r.job_id as string) ?? null,
      debitCents: N(r.debit_cents),
      creditCents: N(r.credit_cents),
      runningNetCents: N(r.running_net_cents),
      entryHref: `/journal-entries?id=${String(r.entry_id)}`,
      sourceHref: src?.href ?? null,
      sourceLabel: src?.label ?? null,
    };
  });
  const dr = N(doc.debit_cents);
  const cr = N(doc.credit_cents);
  return { totalCount: N(doc.total_count), debitCents: dr, creditCents: cr, netCents: dr - cr, lines, limit, offset };
}

// ─── tie-out (admin check) ───────────────────────────────────────────────────

export interface TieOutResult {
  tied: boolean;
  mismatches: Array<{ companyId: string; accountId: string; period: string; kind: string; glNetCents: number; storeNetCents: number }>;
  checkedAt: string;
}

/**
 * Store vs ledger tie-out on the service role (p_org pinned). The route gates it on
 * close_mgmt:manage; mismatch rows are limited to the companies the caller can see and is
 * scoped to (the service role sees the whole org).
 */
export async function runTieOut(ctx: EngineContext): Promise<TieOutResult> {
  if (!ctx.orgId) throw new EngineInputError('No organization.');
  const { data: locs, error: locErr } = await ctx.supabase.schema('core').from('locations').select('id').eq('org_id', ctx.orgId);
  if (locErr) throw new Error(locErr.message);
  const scope = await loadClientScope({ supabase: ctx.supabase });
  const visible = new Set(((locs ?? []) as Array<{ id: string }>).map((l) => l.id).filter((id) => decideClientScope(scope, id).allowed));
  const { data, error } = await engineServiceClient(ctx.service).rpc('period_balances_tieout', { p_org: ctx.orgId });
  if (error) throw new Error(`period_balances_tieout: ${error.message}`);
  const rows = ((data ?? []) as Array<Record<string, unknown>>).filter((r) => visible.has(String(r.location_id)));
  return {
    tied: rows.length === 0,
    mismatches: rows.slice(0, 200).map((r) => ({
      companyId: String(r.location_id),
      accountId: String(r.account_id),
      period: String(r.period_start).slice(0, 10),
      kind: String(r.entry_kind),
      glNetCents: N(r.gl_debit_cents) - N(r.gl_credit_cents),
      storeNetCents: N(r.store_debit_cents) - N(r.store_credit_cents),
    })),
    checkedAt: new Date().toISOString(),
  };
}

// ─── feed for 3B (metric registry) ───────────────────────────────────────────

export interface EngineFeedRequest {
  companyIds: string[];
  /** 'YYYY-MM' or 'YYYY-MM-DD' (month start used) */
  from: string;
  to: string;
  includeBudgets: boolean;
}

/**
 * Balances + reference data for companies × months (with an opening bucket before `from`),
 * client-scope validated (service-role balance read). Structurally satisfies lib/metrics' PeriodBalanceFeed.
 */
export async function loadEngineFeed(ctx: EngineContext, req: EngineFeedRequest): Promise<Pick<EngineData, 'orgFiscalYearStartMonth' | 'accounts' | 'companies' | 'balances' | 'budgets' | 'periodStatus' | 'ownership'>> {
  const { supabase, orgId } = ctx;
  const [accounts, companies, org] = await Promise.all([loadAccounts(supabase), loadCompanies(supabase, orgId), loadOrgFyStart(supabase, orgId)]);
  const companyIds = requireCompanies(await resolveCompanies(ctx, req.companyIds, companies));
  const from = monthStart(req.from.length === 7 ? `${req.from}-01` : req.from);
  const toStart = monthStart(req.to.length === 7 ? `${req.to}-01` : req.to);
  const [y, m] = toStart.split('-').map(Number);
  const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const [balances, budgets, periodStatus, ownership] = await Promise.all([
    rpcBalances(engineServiceClient(ctx.service), orgId, companyIds, { from, to, opening: true }),
    req.includeBudgets ? loadBudgets(supabase, companyIds, from, to) : Promise.resolve([] as BudgetRow[]),
    loadPeriodStatus(supabase, companyIds, from, to),
    loadOwnershipMeta(supabase, orgId, to),
  ]);
  return { orgFiscalYearStartMonth: org.fy, accounts, companies: companies.filter((c) => companyIds.includes(c.id)), balances, budgets, periodStatus, ownership };
}
