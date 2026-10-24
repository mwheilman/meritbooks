/**
 * MetricDataSource over TODAY's tables (RLS-scoped client only — never the admin
 * client; FPB-fr D15). Column names verified against the migrations (Rule 11):
 *   accounts (003) · account_roles (029) · gl_entries / gl_entry_lines / fiscal_periods (004)
 *   budgets (013) / budget_plan_versions (189) · invoices (008, 050) · payment_applications /
 *   customer_payments (008) · bills (005) · bill_payments (030) · core.jobs (008, 011)
 *   payroll_runs / payroll_run_employees (069) · dealer_units / warranty_claims (169)
 *   entity_ownership (076) · core.organizations.fiscal_year_start_month (001)
 *
 * Every read is paged through fetchAll (PostgREST caps responses at 1,000 rows).
 * Reads posted ledger only (`gl_entries.status = 'POSTED'`). Job positions and open
 * warranty claims exist only as CURRENT state, so they are supplied for the latest
 * month only; earlier months read "Not on file".
 *
 * To be replaced (GL part) by the 3A balances store: adapters/period-balances.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { addMonths, monthEndIso, monthOfIso, monthStartIso, type MonthKey } from '@/lib/analytics/months';
import { fetchAll, fetchAllIn } from '@/lib/supabase/fetch-all';
import { classifyAccounts, type AccountMeta } from '../classes';
import type { DataSourceRequest, MetricDataSource } from '../data-source';
import { budgetMonth, foldBudgets, foldGl, lookThroughOwnership, type BudgetLine, type GlLine, type OwnershipRow } from '../fold';
import {
  closeSeries,
  headcountSeries,
  jobSnapshot,
  subledgerSeries,
  unitSeries,
  warrantySeries,
  type OperationalSeries,
  type SubledgerDoc,
} from '../subledger';
import type { CompanyDataset, MetricDataset, OperationalKey } from '../types';

type DB = SupabaseClient;

/** Operational inputs this adapter can supply. */
export const GL_QUERY_OPERATIONAL: OperationalKey[] = [
  'ar_open',
  'ar_current',
  'ar_1_30',
  'ar_31_60',
  'ar_61_90',
  'ar_over_90',
  'credit_sales',
  'customer_days_to_pay_weighted',
  'customer_paid_amount',
  'ap_open',
  'ap_current',
  'ap_1_30',
  'ap_31_60',
  'ap_61_90',
  'ap_over_90',
  'purchases',
  'headcount',
  'jobs_active',
  'backlog',
  'wip_underbillings',
  'wip_overbillings',
  'cost_to_complete',
  'gp_in_backlog',
  'job_contract_value',
  'job_estimated_gp',
  'units_in_stock',
  'unit_days_in_stock',
  'units_aged',
  'warranty_open',
  'warranty_claimed',
  'close_days',
];

const AR_KEYS = new Set<OperationalKey>(['ar_open', 'ar_current', 'ar_1_30', 'ar_31_60', 'ar_61_90', 'ar_over_90', 'credit_sales', 'customer_days_to_pay_weighted', 'customer_paid_amount']);
const AP_KEYS = new Set<OperationalKey>(['ap_open', 'ap_current', 'ap_1_30', 'ap_31_60', 'ap_61_90', 'ap_over_90', 'purchases']);
const JOB_KEYS = new Set<OperationalKey>(['jobs_active', 'backlog', 'wip_underbillings', 'wip_overbillings', 'cost_to_complete', 'gp_in_backlog', 'job_contract_value', 'job_estimated_gp']);
const UNIT_KEYS = new Set<OperationalKey>(['units_in_stock', 'unit_days_in_stock', 'units_aged']);
const WARRANTY_KEYS = new Set<OperationalKey>(['warranty_open', 'warranty_claimed']);

export interface GlQuerySourceOptions {
  orgId: string;
  /** Org-local today (lib/dates/org-today getOrgToday). */
  today: string;
}

function must<T>(res: { data: T[] | null; error: { message: string } | null }, label: string): T[] {
  if (res.error) throw new Error(`metrics ${label}: ${res.error.message}`);
  return res.data ?? [];
}

function one<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

interface AccountRow {
  id: string;
  account_number: string;
  name: string;
  account_type: string;
  account_sub_type: string;
  is_bank_account: boolean | null;
  is_credit_card: boolean | null;
}

interface LineRow {
  account_id: string;
  location_id: string;
  debit_cents: number | string | null;
  credit_cents: number | string | null;
  gl_entries: { entry_date: string; entry_type: string } | { entry_date: string; entry_type: string }[] | null;
}

async function loadAccounts(db: DB): Promise<{ accounts: AccountMeta[]; roles: Map<string, string[]> }> {
  const accounts = must(
    await fetchAll<AccountRow>(() => db.from('accounts').select('id, account_number, name, account_type, account_sub_type, is_bank_account, is_credit_card'), { label: 'metrics accounts' }),
    'accounts',
  ).map((a) => ({
    id: a.id,
    number: a.account_number,
    name: a.name,
    type: a.account_type,
    subType: a.account_sub_type,
    isBank: Boolean(a.is_bank_account),
    isCreditCard: Boolean(a.is_credit_card),
  }));
  const roleRows = must(await fetchAll<{ role_key: string; account_id: string }>(() => db.from('account_roles').select('id, role_key, account_id'), { label: 'metrics account_roles' }), 'account_roles');
  const roles = new Map<string, string[]>();
  for (const r of roleRows) roles.set(r.role_key, [...(roles.get(r.role_key) ?? []), r.account_id]);
  return { accounts, roles };
}

async function loadLines(db: DB, companyIds: string[], from: MonthKey, to: MonthKey, balanceAccountIds: string[]): Promise<GlLine[]> {
  const toLine = (l: LineRow): GlLine | null => {
    const e = one(l.gl_entries);
    if (!e) return null;
    return {
      companyId: l.location_id,
      accountId: l.account_id,
      month: monthOfIso(e.entry_date),
      kind: e.entry_type,
      debitCents: Number(l.debit_cents ?? 0),
      creditCents: Number(l.credit_cents ?? 0),
    };
  };
  const select = 'id, account_id, location_id, debit_cents, credit_cents, gl_entries!inner(entry_date, status, entry_type)';
  const inWindow = must(
    await fetchAllIn<LineRow>(
      companyIds,
      (chunk) =>
        db
          .from('gl_entry_lines')
          .select(select)
          .in('location_id', chunk)
          .eq('gl_entries.status', 'POSTED')
          .gte('gl_entries.entry_date', monthStartIso(from))
          .lte('gl_entries.entry_date', monthEndIso(to)),
      { label: 'metrics gl lines (window)' },
    ),
    'gl lines',
  );
  // Balance-sheet history before the window → opening balances (+ books-start month).
  const before =
    balanceAccountIds.length === 0
      ? []
      : must(
          await fetchAllIn<LineRow>(
            companyIds,
            (chunk) =>
              db
                .from('gl_entry_lines')
                .select(select)
                .in('location_id', chunk)
                .in('account_id', balanceAccountIds)
                .eq('gl_entries.status', 'POSTED')
                .lt('gl_entries.entry_date', monthStartIso(from)),
            { label: 'metrics gl lines (opening)' },
          ),
          'gl opening lines',
        );
  return [...inWindow, ...before].map(toLine).filter((l): l is GlLine => l !== null);
}

/** Earliest posted entry per company (books start), including P&L-only history before the window. */
async function loadFirstMonths(db: DB, companyIds: string[]): Promise<Map<string, MonthKey>> {
  const out = new Map<string, MonthKey>();
  await Promise.all(
    companyIds.map(async (id) => {
      const { data, error } = await db.from('gl_entries').select('entry_date').eq('location_id', id).eq('status', 'POSTED').order('entry_date', { ascending: true }).limit(1);
      if (error) throw new Error(`metrics first entry: ${error.message}`);
      const d = (data ?? [])[0] as { entry_date: string } | undefined;
      if (d) out.set(id, monthOfIso(d.entry_date));
    }),
  );
  return out;
}

async function loadBudgets(db: DB, companyIds: string[], fy: number): Promise<{ lines: BudgetLine[]; approved: Map<string, number[]> }> {
  const rows = must(
    await fetchAllIn<{ location_id: string; account_id: string; fiscal_year: number; period_number: number; amount_cents: number | string }>(
      companyIds,
      (chunk) => db.from('budgets').select('id, location_id, account_id, fiscal_year, period_number, amount_cents').in('location_id', chunk),
      { label: 'metrics budgets' },
    ),
    'budgets',
  );
  const versions = must(
    await fetchAllIn<{ location_id: string; fiscal_year: number }>(
      companyIds,
      // Mig 189: an approved budget = the company-year's current BUDGET version once APPROVED / LOCKED
      // (the legacy budget_versions table was never written and has no location_id on live).
      (chunk) => db.from('budget_plan_versions').select('id, location_id, fiscal_year, status').in('location_id', chunk)
        .eq('kind', 'BUDGET').eq('is_current', true).in('status', ['APPROVED', 'LOCKED']),
      { label: 'metrics budget_plan_versions' },
    ),
    'budget_plan_versions',
  );
  const approved = new Map<string, number[]>();
  for (const v of versions) approved.set(v.location_id, [...(approved.get(v.location_id) ?? []), v.fiscal_year]);
  return {
    lines: rows.map((r) => ({ companyId: r.location_id, accountId: r.account_id, month: budgetMonth(r.fiscal_year, r.period_number, fy), naturalCents: Number(r.amount_cents ?? 0) })),
    approved,
  };
}

interface DocRow {
  id: string;
  location_id: string;
  counterparty: string;
  issue: string;
  due: string;
  total_cents: number | string;
  amount_paid_cents: number | string;
  status: string;
  updated_at: string;
}

async function loadReceivables(db: DB, companyIds: string[], to: MonthKey): Promise<Map<string, SubledgerDoc[]>> {
  const invoices = must(
    await fetchAllIn<{ id: string; location_id: string; customer_id: string; invoice_date: string; due_date: string; total_cents: number | string; amount_paid_cents: number | string; status: string; updated_at: string }>(
      companyIds,
      (chunk) => db.from('invoices').select('id, location_id, customer_id, invoice_date, due_date, total_cents, amount_paid_cents, status, updated_at').in('location_id', chunk).lte('invoice_date', monthEndIso(to)),
      { label: 'metrics invoices' },
    ),
    'invoices',
  );
  const apps = must(
    await fetchAllIn<{ invoice_id: string; amount_cents: number | string; customer_payments: { payment_date: string } | { payment_date: string }[] | null }>(
      invoices.map((i) => i.id),
      (chunk) => db.from('payment_applications').select('id, invoice_id, amount_cents, customer_payments!inner(payment_date)').in('invoice_id', chunk),
      { label: 'metrics payment_applications' },
    ),
    'payment_applications',
  );
  const pays = new Map<string, { date: string; cents: number }[]>();
  for (const a of apps) {
    const p = one(a.customer_payments);
    if (!p) continue;
    pays.set(a.invoice_id, [...(pays.get(a.invoice_id) ?? []), { date: p.payment_date, cents: Number(a.amount_cents ?? 0) }]);
  }
  return groupDocs(
    invoices.map((i) => ({ id: i.id, location_id: i.location_id, counterparty: i.customer_id, issue: i.invoice_date, due: i.due_date, total_cents: i.total_cents, amount_paid_cents: i.amount_paid_cents, status: i.status, updated_at: i.updated_at })),
    pays,
  );
}

async function loadPayables(db: DB, companyIds: string[], to: MonthKey): Promise<Map<string, SubledgerDoc[]>> {
  const bills = must(
    await fetchAllIn<{ id: string; location_id: string; vendor_id: string; bill_date: string; due_date: string; total_cents: number | string; amount_paid_cents: number | string; status: string; updated_at: string }>(
      companyIds,
      (chunk) => db.from('bills').select('id, location_id, vendor_id, bill_date, due_date, total_cents, amount_paid_cents, status, updated_at').in('location_id', chunk).lte('bill_date', monthEndIso(to)),
      { label: 'metrics bills' },
    ),
    'bills',
  );
  const payments = must(
    await fetchAllIn<{ bill_id: string; amount_cents: number | string; payment_date: string; status: string }>(
      bills.map((b) => b.id),
      (chunk) => db.from('bill_payments').select('id, bill_id, amount_cents, payment_date, status').in('bill_id', chunk).neq('status', 'VOIDED'),
      { label: 'metrics bill_payments' },
    ),
    'bill_payments',
  );
  const pays = new Map<string, { date: string; cents: number }[]>();
  for (const p of payments) pays.set(p.bill_id, [...(pays.get(p.bill_id) ?? []), { date: p.payment_date, cents: Number(p.amount_cents ?? 0) }]);
  return groupDocs(
    bills.map((b) => ({ id: b.id, location_id: b.location_id, counterparty: b.vendor_id, issue: b.bill_date, due: b.due_date, total_cents: b.total_cents, amount_paid_cents: b.amount_paid_cents, status: b.status, updated_at: b.updated_at })),
    pays,
  );
}

function groupDocs(rows: DocRow[], pays: Map<string, { date: string; cents: number }[]>): Map<string, SubledgerDoc[]> {
  const out = new Map<string, SubledgerDoc[]>();
  for (const r of rows) {
    const doc: SubledgerDoc = {
      id: r.id,
      counterpartyId: r.counterparty,
      issueDate: r.issue,
      dueDate: r.due,
      totalCents: Number(r.total_cents ?? 0),
      paidCents: Number(r.amount_paid_cents ?? 0),
      status: r.status,
      payments: pays.get(r.id) ?? [],
      lastChangedDate: (r.updated_at ?? '').slice(0, 10),
    };
    out.set(r.location_id, [...(out.get(r.location_id) ?? []), doc]);
  }
  return out;
}

function merge(target: OperationalSeries, src: OperationalSeries, keys?: Set<OperationalKey>): void {
  for (const [k, v] of Object.entries(src) as [OperationalKey, Partial<Record<MonthKey, number>>][]) {
    if (keys && !keys.has(k)) continue;
    target[k] = { ...(target[k] ?? {}), ...v };
  }
}

export function createGlQuerySource(db: DB, opts: GlQuerySourceOptions): MetricDataSource {
  let fyCache: number | null = null;
  const fiscalYearStartMonth = async (): Promise<number> => {
    if (fyCache !== null) return fyCache;
    const { data, error } = await db.schema('core').from('organizations').select('fiscal_year_start_month').eq('id', opts.orgId).maybeSingle();
    if (error) throw new Error(`metrics fiscal year: ${error.message}`);
    fyCache = Number((data as { fiscal_year_start_month: number } | null)?.fiscal_year_start_month ?? 1) || 1;
    return fyCache;
  };

  return {
    id: 'gl-queries-v1',
    fiscalYearStartMonth,
    async load(req: DataSourceRequest): Promise<MetricDataset> {
      const fy = await fiscalYearStartMonth();
      const latestMonth = monthOfIso(opts.today);
      const to = req.to > latestMonth ? latestMonth : req.to;
      const ids = req.companyIds;

      const [{ accounts, roles }, locations, firstMonths, periods, ownershipRows] = await Promise.all([
        loadAccounts(db),
        db.schema('core').from('locations').select('id, name').in('id', ids),
        loadFirstMonths(db, ids),
        fetchAllIn<{ location_id: string; period_year: number; period_month: number; status: string; closed_at: string | null }>(
          ids,
          (chunk) => db.from('fiscal_periods').select('id, location_id, period_year, period_month, status, closed_at').in('location_id', chunk),
          { label: 'metrics fiscal_periods' },
        ),
        fetchAll<{ parent_entity_id: string; child_entity_id: string; ownership_percent: number | string; consolidation_method: string; effective_start: string; effective_end: string | null }>(
          () => db.from('entity_ownership').select('id, parent_entity_id, child_entity_id, ownership_percent, consolidation_method, effective_start, effective_end'),
          { label: 'metrics entity_ownership' },
        ),
      ]);
      if (locations.error) throw new Error(`metrics locations: ${locations.error.message}`);

      const mapping = classifyAccounts(accounts, roles);
      const balanceIds = accounts.filter((a) => a.type === 'ASSET' || a.type === 'LIABILITY' || a.type === 'EQUITY').map((a) => a.id);
      const lines = await loadLines(db, ids, req.from, to, balanceIds);
      const gl = foldGl(lines, mapping, req.from);

      const ownership = lookThroughOwnership(
        must(ownershipRows, 'entity_ownership').map(
          (r): OwnershipRow => ({
            parentId: r.parent_entity_id,
            childId: r.child_entity_id,
            percent: Number(r.ownership_percent ?? 100),
            method: (r.consolidation_method as OwnershipRow['method']) ?? 'FULL',
            effectiveStart: r.effective_start,
            effectiveEnd: r.effective_end,
          }),
        ),
        monthEndIso(to),
      );

      const budgets = req.needsBudget ? await loadBudgets(db, ids, fy) : null;
      const budgetByCompany = budgets ? foldBudgets(budgets.lines, mapping) : new Map();

      const wants = new Set(req.operational);
      const any = (keys: Set<OperationalKey>) => [...keys].some((k) => wants.has(k));
      const [receivables, payables] = await Promise.all([
        any(AR_KEYS) || req.customerRevenue ? loadReceivables(db, ids, to) : Promise.resolve(null),
        any(AP_KEYS) || req.vendorSpend ? loadPayables(db, ids, to) : Promise.resolve(null),
      ]);

      const jobs = any(JOB_KEYS)
        ? must(
            await fetchAllIn<{ location_id: string; status: string; contract_amount_cents: number | null; estimated_revenue_cents: number | null; estimated_cost_cents: number | null; budget_labor_cents: number | null; budget_materials_cents: number | null; budget_subcontractor_cents: number | null; budget_other_cents: number | null; actual_cost_cents: number | null; billed_to_date_cents: number | null; pct_complete: number | string | null }>(
              ids,
              (chunk) =>
                db
                  .schema('core')
                  .from('jobs')
                  .select('id, location_id, status, contract_amount_cents, estimated_revenue_cents, estimated_cost_cents, budget_labor_cents, budget_materials_cents, budget_subcontractor_cents, budget_other_cents, actual_cost_cents, billed_to_date_cents, pct_complete')
                  .in('location_id', chunk),
              { label: 'metrics jobs' },
            ),
            'jobs',
          )
        : [];

      const paid = wants.has('headcount') ? await loadPaid(db, ids, req.from, to) : [];
      const units = any(UNIT_KEYS)
        ? must(await fetchAllIn<{ location_id: string; status: string; received_date: string | null; sold_date: string | null }>(ids, (chunk) => db.from('dealer_units').select('id, location_id, status, received_date, sold_date').in('location_id', chunk), { label: 'metrics dealer_units' }), 'dealer_units')
        : [];
      const claims = any(WARRANTY_KEYS)
        ? must(
            await fetchAllIn<{ location_id: string; status: string; submitted_date: string | null; claimed_cents: number | string; settled_cents: number | string; written_off_cents: number | string; debited_cents: number | string }>(
              ids,
              (chunk) => db.from('warranty_claims').select('id, location_id, status, submitted_date, claimed_cents, settled_cents, written_off_cents, debited_cents').in('location_id', chunk),
              { label: 'metrics warranty_claims' },
            ),
            'warranty_claims',
          )
        : [];

      const periodRows = must(periods, 'fiscal_periods');
      const companies: CompanyDataset[] = ((locations.data ?? []) as { id: string; name: string }[]).map((loc) => {
        const operational: OperationalSeries = {};
        let customerRevenue: CompanyDataset['customerRevenue'];
        let vendorSpend: CompanyDataset['vendorSpend'];
        if (receivables) {
          const s = subledgerSeries(receivables.get(loc.id) ?? [], { side: 'ar', from: req.from, to, today: opts.today });
          merge(operational, s.series);
          customerRevenue = s.byCounterparty;
        }
        if (payables) {
          const s = subledgerSeries(payables.get(loc.id) ?? [], { side: 'ap', from: req.from, to, today: opts.today, excludeStatuses: ['VOIDED'] });
          merge(operational, s.series);
          vendorSpend = s.byCounterparty;
        }
        const snap = jobSnapshot(
          jobs
            .filter((j) => j.location_id === loc.id)
            .map((j) => ({
              status: j.status,
              contractCents: j.contract_amount_cents === null ? null : Number(j.contract_amount_cents),
              estimatedRevenueCents: j.estimated_revenue_cents === null ? null : Number(j.estimated_revenue_cents),
              estimatedCostCents: j.estimated_cost_cents === null ? null : Number(j.estimated_cost_cents),
              budgetSumCents: Number(j.budget_labor_cents ?? 0) + Number(j.budget_materials_cents ?? 0) + Number(j.budget_subcontractor_cents ?? 0) + Number(j.budget_other_cents ?? 0),
              actualCostCents: Number(j.actual_cost_cents ?? 0),
              billedToDateCents: Number(j.billed_to_date_cents ?? 0),
              pctComplete: j.pct_complete === null ? null : Number(j.pct_complete),
            })),
        );
        if (snap) for (const [k, v] of Object.entries(snap) as [OperationalKey, number][]) (operational[k] ??= {})[latestMonth] = v;
        if (wants.has('headcount')) operational.headcount = headcountSeries(paid.filter((p) => p.locationId === loc.id));
        const myUnits = units.filter((u) => u.location_id === loc.id);
        if (myUnits.length > 0) merge(operational, unitSeries(myUnits.map((u) => ({ status: u.status, receivedDate: u.received_date, soldDate: u.sold_date })), req.from, to, opts.today));
        const myClaims = claims.filter((c) => c.location_id === loc.id);
        if (myClaims.length > 0) {
          merge(
            operational,
            warrantySeries(
              myClaims.map((c) => ({ status: c.status, submittedDate: c.submitted_date, claimedCents: Number(c.claimed_cents ?? 0), settledCents: Number(c.settled_cents ?? 0), writtenOffCents: Number(c.written_off_cents ?? 0), debitedCents: Number(c.debited_cents ?? 0) })),
              req.from,
              to,
            ),
          );
        }
        const close = closeSeries(
          periodRows
            .filter((p) => p.location_id === loc.id)
            .map((p) => ({ month: `${p.period_year}-${String(p.period_month).padStart(2, '0')}`, status: p.status, closedAt: p.closed_at })),
        );
        operational.close_days = close.closeDays;

        const first = firstMonths.get(loc.id) ?? gl.firstMonth.get(loc.id) ?? null;
        return {
          id: loc.id,
          name: loc.name,
          ownershipPct: ownership.has(loc.id) ? (ownership.get(loc.id) as number) : null,
          inGroupFrom: null,
          firstMonthOnFile: first,
          closedThrough: close.closedThrough,
          gl: gl.byCompany.get(loc.id) ?? {},
          budget: budgetByCompany.get(loc.id) ?? {},
          budgetApprovedFy: budgets?.approved.get(loc.id) ?? [],
          operational,
          customerRevenue,
          vendorSpend,
        };
      });

      return {
        source: 'gl-queries-v1',
        fyStartMonth: fy,
        rangeStart: req.from,
        latestMonth,
        companies,
        classMapping: mapping,
        operationalAvailable: GL_QUERY_OPERATIONAL,
      };
    },
  };
}

async function loadPaid(db: DB, companyIds: string[], from: MonthKey, to: MonthKey): Promise<{ locationId: string; employeeId: string; payDate: string }[]> {
  const runs = must(
    await fetchAllIn<{ id: string; location_id: string | null; pay_date: string }>(
      companyIds,
      (chunk) =>
        db
          .from('payroll_runs')
          .select('id, location_id, pay_date, status')
          .in('location_id', chunk)
          .in('status', ['APPROVED', 'RELEASED', 'PROCESSING', 'PAID'])
          .gte('pay_date', monthStartIso(addMonths(from, -1)))
          .lte('pay_date', monthEndIso(to)),
      { label: 'metrics payroll_runs' },
    ),
    'payroll_runs',
  );
  const byRun = new Map(runs.map((r) => [r.id, r]));
  const emps = must(
    await fetchAllIn<{ payroll_run_id: string; employee_id: string | null }>(
      runs.map((r) => r.id),
      (chunk) => db.from('payroll_run_employees').select('id, payroll_run_id, employee_id').in('payroll_run_id', chunk),
      { label: 'metrics payroll_run_employees' },
    ),
    'payroll_run_employees',
  );
  return emps
    .filter((e) => e.employee_id)
    .map((e) => {
      const run = byRun.get(e.payroll_run_id);
      return { locationId: run?.location_id ?? '', employeeId: e.employee_id as string, payDate: run?.pay_date ?? '' };
    })
    .filter((p) => p.locationId && p.payDate);
}
