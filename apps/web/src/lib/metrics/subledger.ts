/**
 * Pure builders that turn sub-ledger rows into the monthly operational inputs the
 * registry reads (AR/AP aging, invoiced sales, days to pay, concentration, jobs/WIP,
 * dealer units, headcount, close cycle).
 *
 * Honesty rule for history: a past month-end aging is only emitted when the timing of
 * every settlement that matters to that month is KNOWN (dated payment applications).
 * If a document was settled without a dated payment (or written off) after the month
 * end, we cannot know whether it was open at that month end, so the month is omitted
 * — it reads "Not on file", never a guessed number.
 */

import { daysInMonth, monthEndIso, monthOfIso, monthRange, type MonthKey } from '@/lib/analytics/months';
import { roundCents } from '@/lib/analytics/numbers';
import type { OperationalKey } from './types';

export type MonthValues = Partial<Record<MonthKey, number>>;
export type OperationalSeries = Partial<Record<OperationalKey, MonthValues>>;

function isoDays(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function put(series: OperationalSeries, key: OperationalKey, month: MonthKey, v: number): void {
  const m = (series[key] ??= {});
  m[month] = (m[month] ?? 0) + v;
}

// ── AR / AP aging ──────────────────────────────────────────────────────────

export interface SubledgerDoc {
  id: string;
  counterpartyId: string;
  issueDate: string;
  dueDate: string;
  totalCents: number;
  /** Current amount paid (invoices.amount_paid_cents / bills.amount_paid_cents). */
  paidCents: number;
  /** Lifecycle status; VOIDED / DRAFT documents never count. */
  status: string;
  /** Dated settlements (payment applications / bill payments, not voided). */
  payments: { date: string; cents: number }[];
  /** Last change (updated_at) — bounds when an undated settlement happened. */
  lastChangedDate: string;
}

export interface AgingOptions {
  /** Statuses that are never receivables/payables. */
  excludeStatuses?: string[];
  /** Status meaning the remaining balance was written off. */
  writtenOffStatus?: string;
  /** Today's ISO date: the latest month ages as of today, not a future month end. */
  today: string;
}

export interface AgingBuckets {
  open: number;
  current: number;
  d1_30: number;
  d31_60: number;
  d61_90: number;
  over90: number;
}

/**
 * Aging as of `asOf` (ISO date) — or null when the history cannot be stated (see the
 * honesty rule above).
 */
export function agingAsOf(docs: SubledgerDoc[], asOf: string, opts: AgingOptions): AgingBuckets | null {
  const exclude = new Set(opts.excludeStatuses ?? ['VOIDED', 'DRAFT']);
  const writtenOff = opts.writtenOffStatus ?? 'WRITTEN_OFF';
  const b: AgingBuckets = { open: 0, current: 0, d1_30: 0, d31_60: 0, d61_90: 0, over90: 0 };
  for (const d of docs) {
    if (exclude.has(d.status) || d.issueDate > asOf) continue;
    const dated = d.payments.reduce((s, p) => s + p.cents, 0);
    const paidByAsOf = d.payments.filter((p) => p.date <= asOf).reduce((s, p) => s + p.cents, 0);
    const undated = Math.max(0, d.paidCents - dated) + (d.status === writtenOff ? Math.max(0, d.totalCents - d.paidCents) : 0);
    let open = d.totalCents - paidByAsOf;
    if (undated > 0) {
      if (d.lastChangedDate <= asOf) open -= undated;
      else if (asOf < opts.today) return null; // a settlement of unknown date after this month end
      else open -= undated;
    }
    if (open <= 0) continue;
    b.open += open;
    const late = isoDays(d.dueDate, asOf);
    if (late <= 0) b.current += open;
    else if (late <= 30) b.d1_30 += open;
    else if (late <= 60) b.d31_60 += open;
    else if (late <= 90) b.d61_90 += open;
    else b.over90 += open;
  }
  return b;
}

function asOfFor(month: MonthKey, today: string): string {
  const end = monthEndIso(month);
  return end > today ? today : end;
}

export interface SubledgerSeriesOptions extends AgingOptions {
  from: MonthKey;
  to: MonthKey;
  side: 'ar' | 'ap';
}

/**
 * Monthly operational series for one company's receivables or payables:
 *   ar_* / ap_* aging at each month end (omitted when unknowable),
 *   credit_sales / purchases by issue month (exact),
 *   customer_days_to_pay_weighted + customer_paid_amount (AR, by final-payment month),
 * plus per-month amounts by counterparty for concentration.
 */
export function subledgerSeries(docs: SubledgerDoc[], opts: SubledgerSeriesOptions): { series: OperationalSeries; byCounterparty: Partial<Record<MonthKey, Record<string, number>>> } {
  const series: OperationalSeries = {};
  const byCounterparty: Partial<Record<MonthKey, Record<string, number>>> = {};
  const months = monthRange(opts.from, opts.to);
  const keys = opts.side === 'ar'
    ? (['ar_open', 'ar_current', 'ar_1_30', 'ar_31_60', 'ar_61_90', 'ar_over_90'] as const)
    : (['ap_open', 'ap_current', 'ap_1_30', 'ap_31_60', 'ap_61_90', 'ap_over_90'] as const);
  const flowKey: OperationalKey = opts.side === 'ar' ? 'credit_sales' : 'purchases';
  const exclude = new Set(opts.excludeStatuses ?? ['VOIDED', 'DRAFT']);

  for (const m of months) {
    byCounterparty[m] = {};
    (series[flowKey] ??= {})[m] = 0;
    if (opts.side === 'ar') {
      (series.customer_days_to_pay_weighted ??= {})[m] = 0;
      (series.customer_paid_amount ??= {})[m] = 0;
    }
    const a = agingAsOf(docs, asOfFor(m, opts.today), opts);
    if (!a) continue;
    const vals = [a.open, a.current, a.d1_30, a.d31_60, a.d61_90, a.over90];
    keys.forEach((k, i) => ((series[k] ??= {})[m] = vals[i]));
  }

  for (const d of docs) {
    if (exclude.has(d.status)) continue;
    const im = monthOfIso(d.issueDate);
    if (im >= opts.from && im <= opts.to) {
      series[flowKey]![im] = (series[flowKey]![im] ?? 0) + d.totalCents;
      const rec = byCounterparty[im]!;
      rec[d.counterpartyId] = (rec[d.counterpartyId] ?? 0) + d.totalCents;
    }
    if (opts.side === 'ar' && d.payments.length > 0) {
      const dated = d.payments.reduce((s, p) => s + p.cents, 0);
      if (dated >= d.totalCents && d.totalCents > 0) {
        const last = d.payments.reduce((mx, p) => (p.date > mx ? p.date : mx), d.payments[0].date);
        const pm = monthOfIso(last);
        if (pm >= opts.from && pm <= opts.to) {
          series.customer_days_to_pay_weighted![pm] = (series.customer_days_to_pay_weighted![pm] ?? 0) + Math.max(0, isoDays(d.issueDate, last)) * d.totalCents;
          series.customer_paid_amount![pm] = (series.customer_paid_amount![pm] ?? 0) + d.totalCents;
        }
      }
    }
  }
  return { series, byCounterparty };
}

// ── Jobs / WIP (current position only) ─────────────────────────────────────

export interface JobRow {
  status: string;
  contractCents: number | null;
  estimatedRevenueCents: number | null;
  estimatedCostCents: number | null;
  budgetSumCents: number;
  actualCostCents: number;
  billedToDateCents: number;
  pctComplete: number | null;
}

export interface JobSnapshot {
  jobs_active: number;
  backlog: number;
  wip_underbillings: number;
  wip_overbillings: number;
  cost_to_complete: number;
  gp_in_backlog: number;
  job_contract_value: number;
  job_estimated_gp: number;
}

/**
 * WIP snapshot with the same arithmetic as /api/reports/wip: contract = estimated
 * revenue, else contract amount; cost = estimated cost, else the budget sum; % complete
 * = the job's own %, else cost-to-cost (capped at 100). Over/under billings include
 * COMPLETE jobs (as the WIP schedule does); backlog, cost to complete and GP in backlog
 * cover open jobs (ACTIVE / ON_HOLD). Returns null when there are no such jobs.
 */
export function jobSnapshot(jobs: JobRow[]): JobSnapshot | null {
  const wipStatuses = new Set(['ACTIVE', 'ON_HOLD', 'COMPLETE']);
  const open = new Set(['ACTIVE', 'ON_HOLD']);
  const s: JobSnapshot = { jobs_active: 0, backlog: 0, wip_underbillings: 0, wip_overbillings: 0, cost_to_complete: 0, gp_in_backlog: 0, job_contract_value: 0, job_estimated_gp: 0 };
  let any = false;
  for (const j of jobs) {
    if (!wipStatuses.has(j.status)) continue;
    any = true;
    const contract = (j.estimatedRevenueCents ?? 0) || (j.contractCents ?? 0);
    const estCost = (j.estimatedCostCents ?? 0) || j.budgetSumCents;
    let pct = j.pctComplete ?? 0;
    if (!(pct > 0) && estCost > 0) pct = Math.min(100, Math.round((j.actualCostCents / estCost) * 1000) / 10);
    const earned = Math.round(contract * (pct / 100));
    s.wip_overbillings += Math.max(0, j.billedToDateCents - earned);
    s.wip_underbillings += Math.max(0, earned - j.billedToDateCents);
    if (!open.has(j.status)) continue;
    if (j.status === 'ACTIVE') s.jobs_active += 1;
    const backlog = Math.max(0, contract - earned);
    s.backlog += backlog;
    s.cost_to_complete += Math.max(0, estCost - j.actualCostCents);
    s.job_contract_value += contract;
    s.job_estimated_gp += contract - estCost;
    if (contract > 0) s.gp_in_backlog += roundCents((backlog * (contract - estCost)) / contract);
  }
  return any ? s : null;
}

// ── Dealer units & warranty ────────────────────────────────────────────────

export interface UnitRow {
  status: string;
  receivedDate: string | null;
  soldDate: string | null;
}

/**
 * Units in stock, unit-days and units aged > `agedDays` at each month end (as of today
 * for the current month). Reconstructed from received/sold dates; units whose exit has
 * no date (written off, returned, void) or that never arrived are left out.
 */
export function unitSeries(units: UnitRow[], from: MonthKey, to: MonthKey, today: string, agedDays = 180): OperationalSeries {
  const series: OperationalSeries = {};
  const usable = units.filter((u) => u.receivedDate && !['VOID', 'ON_ORDER', 'IN_TRANSIT', 'WRITTEN_OFF', 'RETURNED'].includes(u.status));
  for (const m of monthRange(from, to)) {
    const asOf = asOfFor(m, today);
    let n = 0;
    let unitDays = 0;
    let aged = 0;
    for (const u of usable) {
      if ((u.receivedDate as string) > asOf) continue;
      if (u.soldDate && u.soldDate <= asOf) continue;
      const age = isoDays(u.receivedDate as string, asOf);
      n += 1;
      unitDays += age;
      if (age > agedDays) aged += 1;
    }
    (series.units_in_stock ??= {})[m] = n;
    (series.unit_days_in_stock ??= {})[m] = unitDays;
    (series.units_aged ??= {})[m] = aged;
  }
  return series;
}

export interface WarrantyRow {
  status: string;
  submittedDate: string | null;
  claimedCents: number;
  settledCents: number;
  writtenOffCents: number;
  debitedCents: number;
}

/** Claims submitted by month (exact); open claims only for the latest month (settlement dates are not kept). */
export function warrantySeries(claims: WarrantyRow[], from: MonthKey, to: MonthKey): OperationalSeries {
  const series: OperationalSeries = {};
  for (const m of monthRange(from, to)) (series.warranty_claimed ??= {})[m] = 0;
  let open = 0;
  for (const c of claims) {
    if (c.status === 'VOID' || c.status === 'DRAFT' || !c.submittedDate) continue;
    const sm = monthOfIso(c.submittedDate);
    if (sm >= from && sm <= to) series.warranty_claimed![sm] = (series.warranty_claimed![sm] ?? 0) + c.claimedCents;
    open += Math.max(0, c.claimedCents - c.settledCents - c.writtenOffCents - c.debitedCents);
  }
  (series.warranty_open ??= {})[to] = open;
  return series;
}

// ── People & practice ──────────────────────────────────────────────────────

/** Headcount per month = distinct employees paid in the month. Months with no payroll are omitted. */
export function headcountSeries(paid: { employeeId: string; payDate: string }[]): MonthValues {
  const sets = new Map<MonthKey, Set<string>>();
  for (const p of paid) {
    const m = monthOfIso(p.payDate);
    const s = sets.get(m) ?? new Set<string>();
    s.add(p.employeeId);
    sets.set(m, s);
  }
  const out: MonthValues = {};
  for (const [m, s] of sets) out[m] = s.size;
  return out;
}

/** Days from each month's end to its hard close; plus the latest hard-closed month. */
export function closeSeries(periods: { month: MonthKey; status: string; closedAt: string | null }[]): { closeDays: MonthValues; closedThrough: MonthKey | null } {
  const closeDays: MonthValues = {};
  let closedThrough: MonthKey | null = null;
  for (const p of periods) {
    if (p.status !== 'HARD_CLOSE') continue;
    if (!closedThrough || p.month > closedThrough) closedThrough = p.month;
    if (p.closedAt) closeDays[p.month] = Math.max(0, isoDays(monthEndIso(p.month), p.closedAt.slice(0, 10)));
  }
  return { closeDays, closedThrough };
}

/** Days in a month (re-exported for adapters building day-weighted inputs). */
export { daysInMonth };
