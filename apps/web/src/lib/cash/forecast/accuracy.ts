/**
 * Forecast accuracy (B9 / AC-CF7) — pure.
 *
 * ACTUALS: posted GL cash lines grouped by journal entry. Within one entry, cash-to-cash movement
 * (a transfer between two cash accounts) is removed: inflow = Σ cash debits − internal, outflow =
 * Σ cash credits − internal, internal = min(debits, credits). Each entry's inflow / outflow is
 * grouped by `gl_entries.source_module` into the accuracy groups below and by the week of its date.
 *
 * FORECAST: the snapshot taken on the Monday of week W (lead 1) holds week W at index 0; the
 * snapshot taken four weeks earlier (lead 4) holds it at index 3.
 *
 * Week accuracy = 1 − |A − F| ÷ |A| (floored at 0); null (not meaningful) when A = 0.
 * MAPE = mean |A − F| ÷ |A| over meaningful weeks; accuracy = max(0, 1 − MAPE).
 */

import { addDays, mondayOf } from './dates';
import type { Category } from './types';

export type AccuracyGroup = 'COLLECTIONS' | 'OTHER_RECEIPTS' | 'VENDOR_PAYMENTS' | 'PAYROLL' | 'DEBT' | 'OTHER_DISBURSEMENTS';

export const ACCURACY_GROUP_LABEL: Readonly<Record<AccuracyGroup, string>> = {
  COLLECTIONS: 'Customer collections',
  OTHER_RECEIPTS: 'Other receipts',
  VENDOR_PAYMENTS: 'Vendor & operating payments',
  PAYROLL: 'Payroll',
  DEBT: 'Debt service',
  OTHER_DISBURSEMENTS: 'Other disbursements',
};

export function groupOfCategory(c: Category): AccuracyGroup {
  switch (c) {
    case 'AR':
    case 'RECURRING_AR':
    case 'DEPOSIT':
      return 'COLLECTIONS';
    case 'OTHER_IN':
    case 'TRANSFER_IN':
    case 'LINE_DRAW':
      return 'OTHER_RECEIPTS';
    case 'AP':
    case 'SUBSCRIPTION':
    case 'OPEX':
    case 'OPEX_RUNRATE':
    case 'CAPEX':
    case 'LEASE':
      return 'VENDOR_PAYMENTS';
    case 'PAYROLL':
    case 'PAYROLL_TAX':
      return 'PAYROLL';
    case 'DEBT_SERVICE':
    case 'LINE_PAYDOWN':
      return 'DEBT';
    default:
      return 'OTHER_DISBURSEMENTS';
  }
}

/** gl_entries.source_module → accuracy group, per direction. */
export function groupOfSource(sourceModule: string | null, direction: 'IN' | 'OUT'): AccuracyGroup {
  const s = (sourceModule ?? '').toUpperCase();
  if (direction === 'IN') {
    if (['INVOICE', 'AR', 'PAYMENT', 'PAYMENTS', 'CUSTOMER_PAYMENT', 'DEPOSIT', 'CUSTOMER_DEPOSIT', 'STRIPE'].includes(s)) return 'COLLECTIONS';
    return 'OTHER_RECEIPTS';
  }
  if (['BILL', 'AP', 'CHECK', 'CHECKS', 'MONEY_MOVEMENT', 'EXPENSE', 'EXPENSES', 'BANK_FEED', 'LEASE', 'SUBSCRIPTION', 'CREDIT_CARD'].includes(s)) return 'VENDOR_PAYMENTS';
  if (s === 'PAYROLL') return 'PAYROLL';
  if (s === 'DEBT') return 'DEBT';
  return 'OTHER_DISBURSEMENTS';
}

export interface ActualCashLine {
  entryId: string;
  entryDate: string;
  sourceModule: string | null;
  companyId: string | null;
  debitCents: number;
  creditCents: number;
}

export interface WeekFlows {
  start: string;
  inflowsCents: number;
  outflowsCents: number;
  byGroup: Partial<Record<AccuracyGroup, number>>;
}

/** Actual weekly cash flows (by group) for weeks starting at each Monday in `weekStarts`. */
export function actualWeeks(lines: readonly ActualCashLine[], weekStarts: readonly string[], companyIds?: ReadonlySet<string> | null): Map<string, WeekFlows> {
  const want = new Set(weekStarts);
  const byEntry = new Map<string, { date: string; source: string | null; dr: number; cr: number }>();
  for (const l of lines) {
    if (companyIds && (!l.companyId || !companyIds.has(l.companyId))) continue;
    const e = byEntry.get(l.entryId) ?? { date: l.entryDate, source: l.sourceModule, dr: 0, cr: 0 };
    e.dr += Math.max(0, Math.round(l.debitCents));
    e.cr += Math.max(0, Math.round(l.creditCents));
    byEntry.set(l.entryId, e);
  }
  const out = new Map<string, WeekFlows>();
  for (const ws of weekStarts) out.set(ws, { start: ws, inflowsCents: 0, outflowsCents: 0, byGroup: {} });
  for (const e of byEntry.values()) {
    const wk = mondayOf(e.date);
    if (!want.has(wk)) continue;
    const internal = Math.min(e.dr, e.cr);
    const inflow = e.dr - internal;
    const outflow = e.cr - internal;
    const w = out.get(wk)!;
    if (inflow > 0) {
      w.inflowsCents += inflow;
      const g = groupOfSource(e.source, 'IN');
      w.byGroup[g] = (w.byGroup[g] ?? 0) + inflow;
    }
    if (outflow > 0) {
      w.outflowsCents += outflow;
      const g = groupOfSource(e.source, 'OUT');
      w.byGroup[g] = (w.byGroup[g] ?? 0) + outflow;
    }
  }
  return out;
}

/** The shape stored in cash_forecast_snapshots.weeks. */
export interface SnapshotWeek {
  start: string;
  inflows: Partial<Record<Category, number>>;
  outflows: Partial<Record<Category, number>>;
  closing: number;
}

export interface SnapshotRow {
  anchorDate: string;
  companyId: string | null;
  openingCents: number;
  weeks: SnapshotWeek[];
}

function groupTotals(w: SnapshotWeek): { inflows: number; outflows: number; byGroup: Partial<Record<AccuracyGroup, number>> } {
  const byGroup: Partial<Record<AccuracyGroup, number>> = {};
  let inflows = 0;
  let outflows = 0;
  for (const [c, v] of Object.entries(w.inflows) as Array<[Category, number]>) {
    inflows += v;
    const g = groupOfCategory(c);
    byGroup[g] = (byGroup[g] ?? 0) + v;
  }
  for (const [c, v] of Object.entries(w.outflows) as Array<[Category, number]>) {
    outflows += v;
    const g = groupOfCategory(c);
    byGroup[g] = (byGroup[g] ?? 0) + v;
  }
  return { inflows, outflows, byGroup };
}

/** 1 − |A − F| / |A|, floored at 0; null when A = 0. */
export function weekAccuracy(actual: number, forecast: number): number | null {
  if (actual === 0) return null;
  return Math.max(0, 1 - Math.abs(actual - forecast) / Math.abs(actual));
}

/** Mean absolute percentage error over the meaningful (A ≠ 0) pairs; null when none. */
export function mape(pairs: ReadonlyArray<{ actual: number; forecast: number }>): number | null {
  const errs = pairs.filter((p) => p.actual !== 0).map((p) => Math.abs(p.actual - p.forecast) / Math.abs(p.actual));
  if (errs.length === 0) return null;
  return errs.reduce((s, e) => s + e, 0) / errs.length;
}

export interface AccuracyWeekRow {
  start: string;
  lead: number;
  snapshotDate: string | null;
  forecastInflows: number | null;
  actualInflows: number;
  forecastOutflows: number | null;
  actualOutflows: number;
  forecastNet: number | null;
  actualNet: number;
  inflowAccuracy: number | null;
  outflowAccuracy: number | null;
  byGroup: Array<{ group: AccuracyGroup; forecast: number | null; actual: number; accuracy: number | null }>;
}

export interface AccuracyReport {
  lead: number;
  weeks: AccuracyWeekRow[];
  inflowMape: number | null;
  outflowMape: number | null;
  /** max(0, 1 − mean of the two MAPEs) — the headline "forecast accuracy". */
  accuracy: number | null;
  /** Rolling accuracy by week (4-week window) — the trust trend. */
  trend: Array<{ start: string; accuracy: number | null }>;
  snapshotsOnFile: number;
}

/**
 * Compare snapshots with actuals for completed weeks. `weekStarts` = the completed weeks to score
 * (oldest → newest). `scopeCompanyId` null = combined snapshots.
 */
export function computeAccuracy(
  snapshots: readonly SnapshotRow[],
  actuals: ReadonlyMap<string, WeekFlows>,
  weekStarts: readonly string[],
  scopeCompanyId: string | null,
  lead = 1,
): AccuracyReport {
  const mine = snapshots.filter((s) => s.companyId === scopeCompanyId);
  const byAnchor = new Map(mine.map((s) => [s.anchorDate, s]));
  const rows: AccuracyWeekRow[] = [];
  for (const ws of weekStarts) {
    const snapDate = addDays(ws, -7 * (lead - 1));
    const snap = byAnchor.get(snapDate);
    const sw = snap?.weeks[lead - 1];
    const fc = sw && sw.start === ws ? groupTotals(sw) : null;
    const a = actuals.get(ws) ?? { start: ws, inflowsCents: 0, outflowsCents: 0, byGroup: {} };
    const groups = Object.keys(ACCURACY_GROUP_LABEL) as AccuracyGroup[];
    rows.push({
      start: ws,
      lead,
      snapshotDate: fc ? snapDate : null,
      forecastInflows: fc ? fc.inflows : null,
      actualInflows: a.inflowsCents,
      forecastOutflows: fc ? fc.outflows : null,
      actualOutflows: a.outflowsCents,
      forecastNet: fc ? fc.inflows - fc.outflows : null,
      actualNet: a.inflowsCents - a.outflowsCents,
      inflowAccuracy: fc ? weekAccuracy(a.inflowsCents, fc.inflows) : null,
      outflowAccuracy: fc ? weekAccuracy(a.outflowsCents, fc.outflows) : null,
      byGroup: groups.map((g) => {
        const f = fc ? (fc.byGroup[g] ?? 0) : null;
        const act = a.byGroup[g] ?? 0;
        return { group: g, forecast: f, actual: act, accuracy: f === null ? null : weekAccuracy(act, f) };
      }),
    });
  }
  const scored = rows.filter((r) => r.forecastInflows !== null);
  const inflowMape = mape(scored.map((r) => ({ actual: r.actualInflows, forecast: r.forecastInflows ?? 0 })));
  const outflowMape = mape(scored.map((r) => ({ actual: r.actualOutflows, forecast: r.forecastOutflows ?? 0 })));
  const parts = [inflowMape, outflowMape].filter((v): v is number => v !== null);
  const accuracy = parts.length ? Math.max(0, 1 - parts.reduce((s, v) => s + v, 0) / parts.length) : null;

  const trend = rows.map((r, i) => {
    const win = rows.slice(Math.max(0, i - 3), i + 1).filter((x) => x.forecastInflows !== null);
    const m1 = mape(win.map((x) => ({ actual: x.actualInflows, forecast: x.forecastInflows ?? 0 })));
    const m2 = mape(win.map((x) => ({ actual: x.actualOutflows, forecast: x.forecastOutflows ?? 0 })));
    const ps = [m1, m2].filter((v): v is number => v !== null);
    return { start: r.start, accuracy: ps.length ? Math.max(0, 1 - ps.reduce((s, v) => s + v, 0) / ps.length) : null };
  });
  return { lead, weeks: rows, inflowMape, outflowMape, accuracy, trend, snapshotsOnFile: mine.length };
}

/**
 * The scope's snapshot per anchor = Σ its companies' snapshots (week by week, category by category).
 * Used for a multi-company scope: GL actuals per company include flows between the companies, so
 * the per-company sum is the like-for-like forecast (and it works for a partial client scope, where
 * the org-wide combined row would not). Returned rows carry companyId null.
 */
export function sumSnapshots(rows: readonly SnapshotRow[], companyIds: readonly string[]): SnapshotRow[] {
  const want = new Set(companyIds);
  const byAnchor = new Map<string, SnapshotRow>();
  for (const r of rows) {
    if (!r.companyId || !want.has(r.companyId)) continue;
    const acc = byAnchor.get(r.anchorDate) ?? { anchorDate: r.anchorDate, companyId: null, openingCents: 0, weeks: [] };
    acc.openingCents += r.openingCents;
    r.weeks.forEach((w, i) => {
      const t = acc.weeks[i] ?? (acc.weeks[i] = { start: w.start, inflows: {}, outflows: {}, closing: 0 });
      t.closing += w.closing;
      for (const [c, v] of Object.entries(w.inflows) as Array<[Category, number]>) t.inflows[c] = (t.inflows[c] ?? 0) + v;
      for (const [c, v] of Object.entries(w.outflows) as Array<[Category, number]>) t.outflows[c] = (t.outflows[c] ?? 0) + v;
    });
    byAnchor.set(r.anchorDate, acc);
  }
  return Array.from(byAnchor.values()).sort((a, b) => (a.anchorDate < b.anchorDate ? -1 : 1));
}

/** Forecast → the snapshot weeks payload (per scope). */
export function toSnapshotWeeks(weeks: ReadonlyArray<{ start: string; byCategory: Partial<Record<Category, number>>; closingCents: number }>, isInflow: (c: Category) => boolean): SnapshotWeek[] {
  return weeks.map((w) => {
    const inflows: Partial<Record<Category, number>> = {};
    const outflows: Partial<Record<Category, number>> = {};
    for (const [c, v] of Object.entries(w.byCategory) as Array<[Category, number]>) {
      if (!v) continue;
      if (isInflow(c)) inflows[c] = v;
      else outflows[c] = v;
    }
    return { start: w.start, inflows, outflows, closing: w.closingCents };
  });
}

/** Completed week starts (oldest → newest) ending the week before `today`'s week. */
export function completedWeeks(today: string, n: number): string[] {
  const thisWeek = mondayOf(today);
  return Array.from({ length: n }, (_, i) => addDays(thisWeek, -7 * (n - i)));
}
