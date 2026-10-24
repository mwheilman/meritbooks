/**
 * Flux review — the RLS-scoped loader (FPB-financial-reports §5 A-3E).
 *
 * Reads the posted GL, the materiality policy, budgets, explanations and the waiver
 * through the CALLER's client (tenant + client-scope isolation enforced by the database),
 * and hands them to the pure assembly in ./board.ts.
 *
 * The ledger read sits behind `FluxBalanceSource`: the default is
 * `periodBalanceFluxSource` (./period-balance-source.ts) — ending balances from the 3A
 * report engine's period balances (migration 185), posted lines from the ledger — with
 * `glBalanceSource` as its fallback when the store is not deployed.
 *
 * All money is bigint cents (read as JS numbers — safe below 2^53).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAll, fetchAllIn, type PageableQuery } from '@/lib/supabase/fetch-all';
import { fetchCoreMap } from '@/lib/stitch-core';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import type { AccountSubType, AccountType } from '@/lib/posting/account-direction';
import { activityFromDetail, assembleFluxBoard, type DetailLine } from './board';
import { lineKeyFor, lookbackMonths, monthBounds, periodKeyOf, periodLabel, shiftPeriod, statementOf, TRAILING_POINTS } from './compute';
import { EXPLANATION_COLUMNS, explanationFromRow, type FluxExplanationRow } from './explanations';
import { FLUX_SIGNAL_UNKNOWN } from './gate';
import { pickPolicy, type FluxPolicyRow } from './materiality';
import type { FluxAccount, FluxBoard, FluxCloseSignal, FluxExplanation, FluxPeriodStatus, FluxPolicy, FluxWaiver } from './types';
// Default source: ending balances from the 3A balances store (mig 185), lines from the ledger.
// (Circular with ./period-balance-source by design — both sides are only used at call time.)
import { periodBalanceFluxSource } from './period-balance-source';

type DB = SupabaseClient;

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

// ─────────────────────────────────────────────────────────────────────────────
// Balance source seam
// ─────────────────────────────────────────────────────────────────────────────

export interface LedgerLine extends DetailLine {
  locationId: string;
}

export interface FluxBalanceSource {
  /** Posted lines with entry_date in [fromDate, toDate] for the companies. */
  lines(args: { locationIds: string[]; fromDate: string; toDate: string }): Promise<LedgerLine[]>;
  /** Ending debit − credit per company → account at `asOfDate` (posted, inclusive). */
  balances(args: { locationIds: string[]; asOfDate: string }): Promise<Map<string, Map<string, number>>>;
}

interface LineRow {
  id: string;
  gl_entry_id: string;
  account_id: string;
  location_id: string;
  department_id: string | null;
  class_id: string | null;
  debit_cents: number | string | null;
  credit_cents: number | string | null;
  memo: string | null;
  gl_entries: { entry_number: string | null; entry_date: string; status: string; memo: string | null; source_module: string | null; entry_type: string | null } | null;
}

const LINE_COLUMNS =
  'id, gl_entry_id, account_id, location_id, department_id, class_id, debit_cents, credit_cents, memo, gl_entries!inner(entry_number, entry_date, status, memo, source_module, entry_type)';

/** The default source: posted `gl_entry_lines` + `v_trial_balance`, RLS-scoped. */
/** A PostgREST builder viewed as the pageable shape `fetchAll` drives (rows typed by the caller). */
function pq<Row>(q: unknown): PageableQuery<Row> {
  return q as PageableQuery<Row>;
}

interface ScopeableQuery<Q> {
  eq(column: string, value: string): Q;
  in(column: string, values: string[]): Q;
}

/** Narrow a query to one company or a set of companies. */
function byLocations<Q>(q: Q, ids: string[]): Q {
  // Viewed through a minimal filter shape: PostgREST's builder generics are too deep to constrain on.
  const f = q as unknown as ScopeableQuery<Q>;
  return ids.length === 1 ? f.eq('location_id', ids[0]) : f.in('location_id', ids);
}

/** The default source: posted `gl_entry_lines` + `v_trial_balance`, RLS-scoped. */
export function glBalanceSource(db: DB): FluxBalanceSource {
  return {
    async lines({ locationIds, fromDate, toDate }) {
      if (locationIds.length === 0) return [];
      const { data, error } = await fetchAll<LineRow>(
        () =>
          pq<LineRow>(
            byLocations(
              db
                .from('gl_entry_lines')
                .select(LINE_COLUMNS)
                .eq('gl_entries.status', 'POSTED')
                .gte('gl_entries.entry_date', fromDate)
                .lte('gl_entries.entry_date', toDate),
              locationIds,
            ),
          ),
        { label: 'flux gl_entry_lines' },
      );
      if (error) throw new Error(error.message);
      return (data ?? []).map((r) => ({
        glLineId: r.id,
        glEntryId: r.gl_entry_id,
        accountId: r.account_id,
        locationId: r.location_id,
        departmentId: r.department_id,
        classId: r.class_id,
        entryNumber: r.gl_entries?.entry_number ?? null,
        entryDate: r.gl_entries?.entry_date ?? fromDate,
        periodKey: (r.gl_entries?.entry_date ?? fromDate).slice(0, 7),
        memo: r.memo ?? r.gl_entries?.memo ?? null,
        sourceModule: r.gl_entries?.source_module ?? null,
        entryType: r.gl_entries?.entry_type ?? null,
        counterparty: null,
        netDebitCents: num(r.debit_cents) - num(r.credit_cents),
        entryAllSameStatement: false,
        entryTouchesCash: false,
      }));
    },

    async balances({ locationIds, asOfDate }) {
      const out = new Map<string, Map<string, number>>();
      if (locationIds.length === 0) return out;
      // All-time posted balance (v_trial_balance) minus anything posted after `asOfDate`.
      type TbRow = { location_id: string; account_id: string; total_debits: number | string; total_credits: number | string };
      type AfterRow = { account_id: string; location_id: string; debit_cents: number | string; credit_cents: number | string };
      const [tb, after] = await Promise.all([
        fetchAll<TbRow>(
          () => pq<TbRow>(byLocations(db.from('v_trial_balance').select('location_id, account_id, total_debits, total_credits'), locationIds)),
          { orderBy: ['org_id', 'location_id', 'account_id'], label: 'flux v_trial_balance' },
        ),
        fetchAll<AfterRow>(
          () =>
            pq<AfterRow>(
              byLocations(
                db
                  .from('gl_entry_lines')
                  .select('id, account_id, location_id, debit_cents, credit_cents, gl_entries!inner(entry_date, status)')
                  .eq('gl_entries.status', 'POSTED')
                  .gt('gl_entries.entry_date', asOfDate),
                locationIds,
              ),
            ),
          { label: 'flux gl_entry_lines (after period)' },
        ),
      ]);
      if (tb.error) throw new Error(tb.error.message);
      if (after.error) throw new Error(after.error.message);
      const add = (loc: string, acc: string, v: number) => {
        const m = out.get(loc) ?? new Map<string, number>();
        m.set(acc, (m.get(acc) ?? 0) + v);
        out.set(loc, m);
      };
      for (const r of tb.data ?? []) add(r.location_id, r.account_id, num(r.total_debits) - num(r.total_credits));
      for (const r of after.data ?? []) add(r.location_id, r.account_id, -(num(r.debit_cents) - num(r.credit_cents)));
      return out;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared reads
// ─────────────────────────────────────────────────────────────────────────────

interface AccountRow {
  id: string;
  account_number: string;
  name: string;
  account_type: AccountType;
  account_sub_type: AccountSubType;
  account_group_id: string | null;
  is_bank_account: boolean | null;
  account_groups: { name: string | null } | null;
}

export interface LoadedAccounts {
  accounts: FluxAccount[];
  cashIds: Set<string>;
}

export async function loadAccounts(db: DB): Promise<LoadedAccounts> {
  const { data, error } = await fetchAll<AccountRow>(
    () => pq<AccountRow>(db.from('accounts').select('id, account_number, name, account_type, account_sub_type, account_group_id, is_bank_account, account_groups(name)')),
    { label: 'flux accounts' },
  );
  if (error) throw new Error(error.message);
  const accounts: FluxAccount[] = [];
  const cashIds = new Set<string>();
  for (const r of data ?? []) {
    accounts.push({
      id: r.id,
      number: r.account_number,
      name: r.name,
      type: r.account_type,
      subType: r.account_sub_type,
      groupId: r.account_group_id,
      groupName: r.account_groups?.name ?? null,
    });
    if (r.is_bank_account) cashIds.add(r.id);
  }
  return { accounts, cashIds };
}

export const POLICY_COLUMNS =
  'id, location_id, review_required, threshold_mode, abs_threshold_cents, pct_threshold_bps, comparison_basis, dimension, include_pnl, include_balance_sheet, overrides, excluded_account_ids, updated_at, updated_by';

export async function loadPolicyRows(db: DB, orgId: string): Promise<FluxPolicyRow[]> {
  const { data, error } = await db.from('flux_materiality_policies').select(POLICY_COLUMNS).eq('org_id', orgId);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as FluxPolicyRow[];
}

export async function loadPolicy(db: DB, orgId: string, locationId: string): Promise<FluxPolicy> {
  return pickPolicy(await loadPolicyRows(db, orgId), locationId);
}

/** Mark each line with whether its entry stays on one statement and touches a bank account. */
export function annotateEntryShape(lines: LedgerLine[], accounts: FluxAccount[], cashIds: Set<string>): void {
  const stmt = new Map(accounts.map((a) => [a.id, statementOf(a.type)]));
  const byEntry = new Map<string, { statements: Set<string>; cash: boolean }>();
  for (const l of lines) {
    const e = byEntry.get(l.glEntryId) ?? { statements: new Set<string>(), cash: false };
    e.statements.add(stmt.get(l.accountId) ?? 'PNL');
    if (cashIds.has(l.accountId)) e.cash = true;
    byEntry.set(l.glEntryId, e);
  }
  for (const l of lines) {
    const e = byEntry.get(l.glEntryId);
    l.entryAllSameStatement = !!e && e.statements.size === 1;
    l.entryTouchesCash = !!e && e.cash;
  }
}

/** Resolve a vendor / customer name per GL entry (bills, invoices, bank-feed rows). */
export async function resolveCounterparties(db: DB, entryIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (entryIds.length === 0) return out;
  try {
    const [bills, invoices, bank] = await Promise.all([
      fetchAllIn<{ id: string; gl_entry_id: string; vendor_id: string | null }>(entryIds, (chunk) => pq(db.from('bills').select('id, gl_entry_id, vendor_id').in('gl_entry_id', chunk)), { label: 'flux bills' }),
      fetchAllIn<{ id: string; gl_entry_id: string; customer_id: string | null }>(entryIds, (chunk) => pq(db.from('invoices').select('id, gl_entry_id, customer_id').in('gl_entry_id', chunk)), { label: 'flux invoices' }),
      fetchAllIn<{ id: string; gl_entry_id: string; final_vendor_id: string | null; ai_vendor_id: string | null; description: string | null }>(
        entryIds,
        (chunk) => pq(db.from('bank_transactions').select('id, gl_entry_id, final_vendor_id, ai_vendor_id, description').in('gl_entry_id', chunk)),
        { label: 'flux bank_transactions' },
      ),
    ]);
    const vendorIds = [...(bills.data ?? []).map((b) => b.vendor_id), ...(bank.data ?? []).map((b) => b.final_vendor_id ?? b.ai_vendor_id)];
    const customerIds = (invoices.data ?? []).map((i) => i.customer_id);
    const [vendors, customers] = await Promise.all([
      fetchCoreMap<{ id: string; name: string; display_name: string | null }>(db, 'vendors', 'id, name, display_name', vendorIds),
      fetchCoreMap<{ id: string; name: string; display_name: string | null }>(db, 'customers', 'id, name, display_name', customerIds),
    ]);
    const nameOf = (m: Map<string, { name: string; display_name: string | null }>, id: string | null) => (id ? m.get(id)?.display_name || m.get(id)?.name || null : null);
    for (const b of bills.data ?? []) { const n = nameOf(vendors, b.vendor_id); if (n) out.set(b.gl_entry_id, n); }
    for (const i of invoices.data ?? []) { const n = nameOf(customers, i.customer_id); if (n) out.set(i.gl_entry_id, n); }
    for (const t of bank.data ?? []) {
      if (out.has(t.gl_entry_id)) continue;
      const n = nameOf(vendors, t.final_vendor_id ?? t.ai_vendor_id) ?? (t.description ? t.description.slice(0, 60) : null);
      if (n) out.set(t.gl_entry_id, n);
    }
  } catch (e) {
    // Counterparty names are context, not figures — degrade to "no counterparty".
    console.warn('[flux] counterparty resolution failed:', e instanceof Error ? e.message : e);
  }
  return out;
}

export async function userNames(db: DB, clerkIds: ReadonlyArray<string | null | undefined>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const ids = Array.from(new Set(clerkIds.filter((x): x is string => typeof x === 'string' && x.length > 0)));
  if (ids.length === 0) return out;
  try {
    const { data } = await db.schema('core').from('users').select('clerk_user_id, first_name, last_name, email').in('clerk_user_id', ids);
    for (const u of (data ?? []) as Array<{ clerk_user_id: string; first_name: string | null; last_name: string | null; email: string | null }>) {
      const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || '';
      if (name) out[u.clerk_user_id] = name;
    }
  } catch {
    /* presentation only */
  }
  return out;
}

interface WaiverRow { location_id: string; status: string; waived_reason: string | null; waived_by: string | null; waived_at: string | null }

function waiverFromRow(r: WaiverRow | null | undefined): FluxWaiver | null {
  if (!r) return null;
  return { status: r.status === 'WAIVED' ? 'WAIVED' : 'OPEN', reason: r.waived_reason, waivedBy: r.waived_by, waivedAt: r.waived_at };
}

async function loadBudget(db: DB, locationId: string, year: number, month: number, policy: FluxPolicy): Promise<Map<string, number> | null> {
  if (policy.comparisonBasis !== 'BUDGET') return null;
  const { data, error } = await db
    .from('budgets')
    .select('account_id, department_id, amount_cents')
    .eq('location_id', locationId)
    .eq('fiscal_year', year)
    .eq('period_number', month);
  if (error) throw new Error(error.message);
  const out = new Map<string, number>();
  for (const r of (data ?? []) as Array<{ account_id: string; department_id: string | null; amount_cents: number | string }>) {
    const key = policy.dimension === 'ACCOUNT_DEPARTMENT' ? lineKeyFor(r.account_id, 'PNL', 'ACCOUNT_DEPARTMENT', r.department_id, null) : r.account_id;
    out.set(key, (out.get(key) ?? 0) + num(r.amount_cents));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The board (one company, one month)
// ─────────────────────────────────────────────────────────────────────────────

export interface LoadBoardArgs {
  locationId: string;
  year: number;
  month: number;
  source?: FluxBalanceSource;
}

export async function loadFluxBoard(db: DB, orgId: string, args: LoadBoardArgs): Promise<FluxBoard> {
  const periodKey = periodKeyOf(args.year, args.month);
  const { start, end } = monthBounds(periodKey);
  const source = args.source ?? periodBalanceFluxSource(db, orgId);

  const [locRes, periodRes, policyRows, { accounts, cashIds }] = await Promise.all([
    db.schema('core').from('locations').select('id, name').eq('id', args.locationId).maybeSingle(),
    db.from('fiscal_periods').select('id, status').eq('location_id', args.locationId).eq('period_year', args.year).eq('period_month', args.month).maybeSingle(),
    loadPolicyRows(db, orgId),
    loadAccounts(db),
  ]);
  const loc = locRes.data as { id: string; name: string } | null;
  if (!loc) throw new FluxNotFoundError('Company not found');
  const period = periodRes.data as { id: string; status: FluxPeriodStatus } | null;
  const policy = pickPolicy(policyRows, args.locationId);

  // Window: trailing series + comparison + the 3 prior months (one-off / new detection).
  const back = Math.max(TRAILING_POINTS - 1, lookbackMonths(policy.comparisonBasis), 3);
  const fromDate = monthBounds(shiftPeriod(periodKey, -back)).start;
  const histKeys = [1, 2, 3].map((n) => shiftPeriod(periodKey, -n));

  const [lines, balances, budget, explRes, histRes, waiverRes] = await Promise.all([
    source.lines({ locationIds: [args.locationId], fromDate, toDate: end }),
    source.balances({ locationIds: [args.locationId], asOfDate: end }),
    loadBudget(db, args.locationId, args.year, args.month, policy),
    db.from('flux_explanations').select(EXPLANATION_COLUMNS).eq('location_id', args.locationId).eq('period_key', periodKey),
    db.from('flux_explanations').select(EXPLANATION_COLUMNS).eq('location_id', args.locationId).in('period_key', histKeys).neq('status', 'DRAFT'),
    db.from('flux_reviews').select('location_id, status, waived_reason, waived_by, waived_at').eq('location_id', args.locationId).eq('period_key', periodKey).maybeSingle(),
  ]);
  for (const r of [explRes, histRes, waiverRes]) if (r.error) throw new Error(r.error.message);

  annotateEntryShape(lines, accounts, cashIds);
  const recentKeys = new Set([periodKey, ...histKeys, shiftPeriod(periodKey, -12)]);
  const detailEntryIds = [...new Set(lines.filter((l) => recentKeys.has(l.periodKey)).map((l) => l.glEntryId))];
  const deptIds = [...new Set(lines.map((l) => l.departmentId).filter((x): x is string => !!x))];
  const classIds = [...new Set(lines.map((l) => l.classId).filter((x): x is string => !!x))];
  const [cps, depts, classes] = await Promise.all([
    resolveCounterparties(db, detailEntryIds),
    policy.dimension === 'ACCOUNT_DEPARTMENT' ? fetchCoreMap<{ id: string; name: string }>(db, 'departments', 'id, name', deptIds) : Promise.resolve(new Map<string, { id: string; name: string }>()),
    policy.dimension === 'ACCOUNT_CLASS' ? fetchCoreMap<{ id: string; name: string }>(db, 'classes', 'id, name', classIds) : Promise.resolve(new Map<string, { id: string; name: string }>()),
  ]);
  for (const l of lines) l.counterparty = cps.get(l.glEntryId) ?? null;
  const dimensionNames = new Map<string, string>();
  for (const [id, d] of depts) dimensionNames.set(id, d.name);
  for (const [id, c] of classes) dimensionNames.set(id, c.name);

  const explanations = ((explRes.data ?? []) as unknown as FluxExplanationRow[]).map(explanationFromRow);
  const history = ((histRes.data ?? []) as unknown as FluxExplanationRow[]).map(explanationFromRow);
  const waiver = waiverFromRow(waiverRes.data as WaiverRow | null);

  const assembled = assembleFluxBoard({
    periodKey,
    accounts,
    policy,
    activity: activityFromDetail(lines),
    closingBalanceDebit: balances.get(args.locationId) ?? new Map(),
    budget,
    dimensionNames,
    detail: lines.filter((l) => recentKeys.has(l.periodKey)),
    explanations,
    history,
    waiver,
  });

  const names = await userNames(db, [
    ...explanations.flatMap((e) => [e.preparedBy, e.reviewedBy]),
    waiver?.waivedBy,
  ]);

  const periodStatus: FluxPeriodStatus = period?.status ?? 'NO_PERIOD';
  return {
    period: { key: periodKey, label: periodLabel(periodKey), year: args.year, month: args.month, start, end },
    location: { id: loc.id, name: loc.name },
    fiscalPeriodId: period?.id ?? null,
    periodStatus,
    editable: periodStatus !== 'HARD_CLOSE',
    policy,
    lines: assembled.lines,
    summary: assembled.summary,
    gate: assembled.gate,
    waiver,
    aiConfigured: getAnthropicApiKey() !== null,
    names,
    generatedAt: new Date().toISOString(),
  };
}

export class FluxNotFoundError extends Error {
  readonly status = 404;
}

// ─────────────────────────────────────────────────────────────────────────────
// Close signals (many companies, one month) — feeds `flux_reviewed`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The close task's view of every company's flux review for a month. A read error fails
 * CLOSED for every company asked about (UNKNOWN blocks the hard close).
 */
export async function loadFluxCloseSignals(
  db: DB,
  orgId: string,
  periodKey: string,
  locationIds: string[],
  source?: FluxBalanceSource,
): Promise<Map<string, FluxCloseSignal>> {
  const out = new Map<string, FluxCloseSignal>();
  if (locationIds.length === 0) return out;
  try {
    const src = source ?? periodBalanceFluxSource(db, orgId);
    const { end } = monthBounds(periodKey);
    const policyRows = await loadPolicyRows(db, orgId);
    const policies = new Map(locationIds.map((l) => [l, pickPolicy(policyRows, l)]));
    const needed = locationIds.filter((l) => policies.get(l)!.reviewRequired);
    for (const l of locationIds) {
      if (!policies.get(l)!.reviewRequired) {
        out.set(l, { applicable: false, status: 'NOT_REQUIRED', material: 0, explained: 0, reviewed: 0, stale: 0, unexplained: 0, waiverReason: null });
      }
    }
    if (needed.length === 0) return out;

    const back = Math.max(...needed.map((l) => lookbackMonths(policies.get(l)!.comparisonBasis)));
    const fromDate = monthBounds(shiftPeriod(periodKey, -back)).start;
    const [y, m] = periodKey.split('-').map(Number);
    const [{ accounts }, lines, balances, explRes, waiverRes, budgets] = await Promise.all([
      loadAccounts(db),
      src.lines({ locationIds: needed, fromDate, toDate: end }),
      src.balances({ locationIds: needed, asOfDate: end }),
      fetchAll<FluxExplanationRow>(
        () => pq<FluxExplanationRow>(db.from('flux_explanations').select(EXPLANATION_COLUMNS).eq('period_key', periodKey).in('location_id', needed)),
        { label: 'flux explanations (signals)' },
      ),
      db.from('flux_reviews').select('location_id, status, waived_reason, waived_by, waived_at').eq('period_key', periodKey).in('location_id', needed),
      Promise.all(needed.map(async (l) => [l, await loadBudget(db, l, y, m, policies.get(l)!)] as const)),
    ]);
    if (explRes.error) throw new Error(explRes.error.message);
    if (waiverRes.error) throw new Error(waiverRes.error.message);
    const budgetByLoc = new Map(budgets);

    const linesByLoc = new Map<string, LedgerLine[]>();
    for (const l of lines) linesByLoc.set(l.locationId, [...(linesByLoc.get(l.locationId) ?? []), l]);
    const explByLoc = new Map<string, FluxExplanation[]>();
    for (const r of explRes.data ?? []) {
      const e = explanationFromRow(r);
      explByLoc.set(e.locationId, [...(explByLoc.get(e.locationId) ?? []), e]);
    }
    const waiverByLoc = new Map(((waiverRes.data ?? []) as WaiverRow[]).map((w) => [w.location_id, waiverFromRow(w)]));

    for (const loc of needed) {
      const { gate } = assembleFluxBoard({
        periodKey,
        accounts,
        policy: policies.get(loc)!,
        activity: activityFromDetail(linesByLoc.get(loc) ?? []),
        closingBalanceDebit: balances.get(loc) ?? new Map(),
        budget: budgetByLoc.get(loc) ?? null,
        detail: [],
        explanations: explByLoc.get(loc) ?? [],
        history: [],
        waiver: waiverByLoc.get(loc) ?? null,
      });
      out.set(loc, gate);
    }
  } catch (e) {
    console.warn('[flux] close signal load failed (fail closed):', e instanceof Error ? e.message : e);
    for (const l of locationIds) out.set(l, FLUX_SIGNAL_UNKNOWN);
  }
  return out;
}
