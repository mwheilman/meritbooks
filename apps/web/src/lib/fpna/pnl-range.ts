/**
 * P&L section totals by calendar month for ANY month range — the read behind period-aware KPIs
 * (FP&A command center, home "Performance" widget) when the user picks YTD, TTM, last year, a
 * quarter or a custom range from the shared PeriodPicker.
 *
 * Same account-type math as /api/fpna/dashboard and the income statement: natural sign per type
 * (REVENUE = credit − debit; COGS / OPEX / OTHER = debit − credit, so net income = revenue − cogs
 * − opex − other). Direction derives from account TYPE, never from an account number (canon §3).
 * Posted entries only. Every read is paged (PostgREST caps a response at 1,000 rows) and runs on
 * the caller's RLS-scoped client with an explicit org filter.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAll } from '@/lib/supabase/fetch-all';
import type { PnlAggregate } from '@/lib/fpna/dashboard';
import { fiscalYearMonths, fiscalYearOf, isMonthKey, normalizeFyStart, type MonthKey } from '@/lib/period/resolve';

const PNL_TYPES = ['REVENUE', 'COGS', 'OPEX', 'OTHER'] as const;
type PnlType = (typeof PNL_TYPES)[number];

export type PnlByMonth = Record<MonthKey, PnlAggregate>;

export function emptyPnl(): PnlAggregate {
  return { revenueCents: 0, cogsCents: 0, opexCents: 0, otherCents: 0 };
}

function isPnlType(t: unknown): t is PnlType {
  return typeof t === 'string' && (PNL_TYPES as readonly string[]).includes(t);
}

/** Natural-sign amount of one line for its account type. */
export function naturalAmount(type: PnlType, debitCents: number, creditCents: number): number {
  return type === 'REVENUE' ? creditCents - debitCents : debitCents - creditCents;
}

function addTo(agg: PnlAggregate, type: PnlType, v: number): void {
  if (type === 'REVENUE') agg.revenueCents += v;
  else if (type === 'COGS') agg.cogsCents += v;
  else if (type === 'OPEX') agg.opexCents += v;
  else agg.otherCents += v;
}

export interface PnlLine {
  /** 'YYYY-MM-DD' */
  entryDate: string;
  accountType: string;
  debitCents: number;
  creditCents: number;
}

/** Bucket GL lines into month → section totals (PURE). Non-P&L lines are ignored. */
export function bucketPnlByMonth(lines: Iterable<PnlLine>): PnlByMonth {
  const out: PnlByMonth = {};
  for (const l of lines) {
    if (!isPnlType(l.accountType)) continue;
    const k = String(l.entryDate).slice(0, 7);
    if (!isMonthKey(k)) continue;
    addTo((out[k] ??= emptyPnl()), l.accountType, naturalAmount(l.accountType, Number(l.debitCents) || 0, Number(l.creditCents) || 0));
  }
  return out;
}

/** Sum the months of a window (PURE). Missing months are zero. */
export function sumPnl(byMonth: PnlByMonth, months: readonly MonthKey[]): PnlAggregate {
  const agg = emptyPnl();
  for (const m of months) {
    const v = byMonth[m];
    if (!v) continue;
    agg.revenueCents += v.revenueCents;
    agg.cogsCents += v.cogsCents;
    agg.opexCents += v.opexCents;
    agg.otherCents += v.otherCents;
  }
  return agg;
}

/**
 * Keep only the months governance shows (PURE) — a withheld month's figures never leave the
 * server (lib/reports/governance/route-guard).
 */
export function keepMonths(byMonth: PnlByMonth, shown: (month: MonthKey) => boolean): PnlByMonth {
  const out: PnlByMonth = {};
  for (const [m, v] of Object.entries(byMonth)) if (shown(m)) out[m] = v;
  return out;
}

export function netIncomeOf(p: PnlAggregate): number {
  return p.revenueCents - p.cogsCents - p.opexCents - p.otherCents;
}

export interface PnlScope {
  orgId: string;
  locationIds: readonly string[];
  departmentId?: string | null;
}

interface LineRow {
  id: string;
  debit_cents: number | string | null;
  credit_cents: number | string | null;
  accounts: { account_type: string } | Array<{ account_type: string }> | null;
  gl_entries: { entry_date: string; status: string } | Array<{ entry_date: string; status: string }> | null;
}

const one = <T>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);

/** Posted P&L actuals by month for [fromMonth, toMonth] (I/O). */
export async function loadPnlByMonth(
  supabase: SupabaseClient,
  scope: PnlScope,
  fromMonth: MonthKey,
  toMonth: MonthKey,
): Promise<{ data: PnlByMonth; error: string | null }> {
  const lastDay = new Date(Date.UTC(Number(toMonth.slice(0, 4)), Number(toMonth.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const build = () => {
    let q = supabase
      .from('gl_entry_lines')
      .select('id, debit_cents, credit_cents, accounts!inner(account_type), gl_entries!inner(entry_date, status)')
      .eq('org_id', scope.orgId)
      .eq('gl_entries.status', 'POSTED')
      .gte('gl_entries.entry_date', `${fromMonth}-01`)
      .lte('gl_entries.entry_date', lastDay)
      .in('accounts.account_type', [...PNL_TYPES]);
    if (scope.locationIds.length === 1) q = q.eq('location_id', scope.locationIds[0]);
    else if (scope.locationIds.length > 1) q = q.in('location_id', [...scope.locationIds]);
    if (scope.departmentId) q = q.eq('department_id', scope.departmentId);
    return q;
  };
  const { data, error } = await fetchAll<LineRow>(build, { label: 'pnl-range gl_entry_lines' });
  if (error) return { data: {}, error: error.message };
  const lines: PnlLine[] = [];
  for (const r of data ?? []) {
    const e = one(r.gl_entries);
    const a = one(r.accounts);
    if (!e || !a) continue;
    lines.push({ entryDate: e.entry_date, accountType: a.account_type, debitCents: Number(r.debit_cents ?? 0), creditCents: Number(r.credit_cents ?? 0) });
  }
  return { data: bucketPnlByMonth(lines), error: null };
}

export interface BudgetCell {
  fiscalYear: number;
  periodNumber: number;
  accountType: string;
  amountCents: number;
}

/**
 * Budget cells → month → section totals (PURE). `fiscal_year` is the year the fiscal year ends
 * in and `period_number` its 1–12 month (13 = adjustment, folded into the last month) — the
 * same mapping lib/metrics/fold.ts `budgetMonth` uses. Budgets are stored natural-sign.
 */
export function bucketBudgetByMonth(cells: Iterable<BudgetCell>, fyStartMonth: number): PnlByMonth {
  const fy = normalizeFyStart(fyStartMonth);
  const out: PnlByMonth = {};
  for (const c of cells) {
    if (!isPnlType(c.accountType)) continue;
    const p = Math.min(12, Math.max(1, Math.trunc(c.periodNumber)));
    const k = fiscalYearMonths(c.fiscalYear, fy)[p - 1];
    addTo((out[k] ??= emptyPnl()), c.accountType, Number(c.amountCents) || 0);
  }
  return out;
}

interface BudgetRow {
  id: string;
  fiscal_year: number;
  period_number: number;
  amount_cents: number | string;
  account: { account_type: string } | Array<{ account_type: string }> | null;
}

/** Budget P&L by month for the fiscal years that cover [fromMonth, toMonth] (I/O). */
export async function loadBudgetPnlByMonth(
  supabase: SupabaseClient,
  scope: PnlScope,
  fromMonth: MonthKey,
  toMonth: MonthKey,
  fyStartMonth: number,
): Promise<{ data: PnlByMonth; hasBudget: boolean; error: string | null }> {
  const fys: number[] = [];
  for (let y = fiscalYearOf(fromMonth, fyStartMonth); y <= fiscalYearOf(toMonth, fyStartMonth); y++) fys.push(y);
  const build = () => {
    let q = supabase
      .from('budgets')
      .select('id, fiscal_year, period_number, amount_cents, account:accounts!budgets_account_id_fkey(account_type)')
      .eq('org_id', scope.orgId)
      .in('fiscal_year', fys);
    if (scope.locationIds.length === 1) q = q.eq('location_id', scope.locationIds[0]);
    else if (scope.locationIds.length > 1) q = q.in('location_id', [...scope.locationIds]);
    if (scope.departmentId) q = q.eq('department_id', scope.departmentId);
    return q;
  };
  const { data, error } = await fetchAll<BudgetRow>(build, { label: 'pnl-range budgets' });
  if (error) return { data: {}, hasBudget: false, error: error.message };
  const cells: BudgetCell[] = [];
  for (const r of data ?? []) {
    const a = one(r.account);
    if (!a) continue;
    cells.push({ fiscalYear: Number(r.fiscal_year), periodNumber: Number(r.period_number), accountType: a.account_type, amountCents: Number(r.amount_cents) });
  }
  return { data: bucketBudgetByMonth(cells, fyStartMonth), hasBudget: cells.length > 0, error: null };
}
