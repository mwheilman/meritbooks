/**
 * Pure folds shared by every MetricDataSource adapter:
 *
 *   foldGl          GL lines (or 3A period-balance rows) → per company, per class,
 *                   monthly flows in the class's measure + the opening balance.
 *   foldBudgets     budget rows (natural sign) → per company, per P&L class, per month.
 *   lookThroughOwnership  entity_ownership rows → each company's effective group %.
 *   budgetMonth     budgets.fiscal_year + period_number → calendar month.
 *
 * CLOSING entries (year-end close to retained earnings) are excluded from P&L and
 * activity flows — otherwise December revenue would read as zero — but included in
 * balance classes so balances stay right (same rule as the 3A engine, mig 185).
 */

import { addMonths, fiscalYearStart, monthIndex, type MonthKey } from '@/lib/analytics/months';
import { ACCOUNT_CLASSES, isNetClass } from './classes';
import type { AccountClass, ClassMapping, GlClassSeries } from './types';

export interface GlLine {
  companyId: string;
  accountId: string;
  /** Month of the entry; null = before the dataset range (the opening bucket). */
  month: MonthKey | null;
  /** gl_entries.entry_type / 3A entry kind. Only 'CLOSING' is treated specially. */
  kind: string;
  debitCents: number;
  creditCents: number;
}

export type ClassIndex = Map<string, AccountClass[]>;

/** account id → the classes it feeds (an account may feed several, e.g. OPEX and D&A). */
export function indexClasses(mapping: Partial<Record<AccountClass, ClassMapping>>): ClassIndex {
  const idx: ClassIndex = new Map();
  for (const [cls, m] of Object.entries(mapping) as [AccountClass, ClassMapping][]) {
    for (const id of m.accountIds) {
      const list = idx.get(id) ?? [];
      list.push(cls);
      idx.set(id, list);
    }
  }
  return idx;
}

function measured(cls: AccountClass, debit: number, credit: number): number {
  switch (ACCOUNT_CLASSES[cls].measure) {
    case 'net_debit':
      return debit - credit;
    case 'net_credit':
      return credit - debit;
    case 'debit_activity':
      return debit;
    case 'credit_activity':
      return credit;
    default:
      return 0;
  }
}

export interface FoldedGl {
  byCompany: Map<string, Partial<Record<AccountClass, GlClassSeries>>>;
  /** Earliest month with a line per company (null bucket ⇒ before `rangeStart`). */
  firstMonth: Map<string, MonthKey>;
}

/**
 * @param rangeStart lines with a month before it are folded into the opening balance.
 */
export function foldGl(lines: Iterable<GlLine>, mapping: Partial<Record<AccountClass, ClassMapping>>, rangeStart: MonthKey): FoldedGl {
  const idx = indexClasses(mapping);
  const byCompany: FoldedGl['byCompany'] = new Map();
  const firstMonth = new Map<string, MonthKey>();
  const beforeRange = addMonths(rangeStart, -1);
  for (const l of lines) {
    const month = l.month === null || l.month < rangeStart ? null : l.month;
    const seen = month ?? (l.month ?? beforeRange);
    const prevFirst = firstMonth.get(l.companyId);
    if (!prevFirst || seen < prevFirst) firstMonth.set(l.companyId, seen);
    const classes = idx.get(l.accountId);
    if (!classes) continue;
    let company = byCompany.get(l.companyId);
    if (!company) {
      company = {};
      byCompany.set(l.companyId, company);
    }
    for (const cls of classes) {
      const net = isNetClass(cls) && ACCOUNT_CLASSES[cls].statement === 'balance_sheet';
      if (l.kind === 'CLOSING' && !net) continue; // P&L and activity flows exclude the year-end close
      const v = measured(cls, l.debitCents, l.creditCents);
      if (v === 0) continue;
      const series = (company[cls] ??= { opening: 0, months: {} });
      if (month === null) {
        if (net) series.opening += v; // P&L opening is irrelevant (flows are windowed)
      } else {
        series.months[month] = (series.months[month] ?? 0) + v;
      }
    }
  }
  return { byCompany, firstMonth };
}

export interface BudgetLine {
  companyId: string;
  accountId: string;
  month: MonthKey;
  /** Natural sign (normal-balance positive) — the budgets table convention. */
  naturalCents: number;
}

/** Budgets feed income-statement classes only (balance budgets are not supported). */
export function foldBudgets(lines: Iterable<BudgetLine>, mapping: Partial<Record<AccountClass, ClassMapping>>): Map<string, Partial<Record<AccountClass, Partial<Record<MonthKey, number>>>>> {
  const idx = indexClasses(mapping);
  const out = new Map<string, Partial<Record<AccountClass, Partial<Record<MonthKey, number>>>>>();
  for (const b of lines) {
    for (const cls of idx.get(b.accountId) ?? []) {
      if (ACCOUNT_CLASSES[cls].statement !== 'income_statement') continue;
      let company = out.get(b.companyId);
      if (!company) {
        company = {};
        out.set(b.companyId, company);
      }
      const m = (company[cls] ??= {});
      m[b.month] = (m[b.month] ?? 0) + b.naturalCents;
    }
  }
  return out;
}

/**
 * Calendar month of a budget cell. `fiscalYear` is the year the fiscal year ENDS in
 * (calendar-year tenants: the calendar year). Period 13 (an adjustment period) lands
 * on the last month of the year.
 */
export function budgetMonth(fiscalYear: number, periodNumber: number, fyStartMonth: number): MonthKey {
  const p = Math.min(12, Math.max(1, periodNumber));
  // The fiscal year that ends in `fiscalYear` starts in fiscalYear − 1 unless it is calendar.
  const lastMonth: MonthKey = `${fiscalYear}-${String(fyStartMonth === 1 ? 12 : fyStartMonth - 1).padStart(2, '0')}`;
  const start = fiscalYearStart(lastMonth, fyStartMonth);
  return addMonths(start, p - 1);
}

export interface OwnershipRow {
  parentId: string;
  childId: string;
  /** 0..100 */
  percent: number;
  method: 'FULL' | 'EQUITY' | 'NONE';
  effectiveStart: string; // ISO date
  effectiveEnd: string | null;
}

/**
 * Look-through group ownership (0..100) per company as of `asOf` (ISO date):
 *   pct(child) = Σ over parents p: row% × pct(p) / 100, roots (never a child) = 100.
 * Rows in effect at `asOf` win; a company whose only rows start later uses the latest
 * row (a row created today defaults its start to today). Method NONE contributes 0.
 * Companies that are neither parent nor child are omitted (caller treats as unknown).
 */
export function lookThroughOwnership(rows: OwnershipRow[], asOf: string): Map<string, number> {
  const inEffect = (r: OwnershipRow) => r.effectiveStart <= asOf && (r.effectiveEnd === null || r.effectiveEnd >= asOf);
  const byChild = new Map<string, OwnershipRow[]>();
  for (const r of rows) byChild.set(r.childId, [...(byChild.get(r.childId) ?? []), r]);
  const chosen = new Map<string, OwnershipRow[]>();
  for (const [child, rs] of byChild) {
    const current = rs.filter(inEffect);
    if (current.length > 0) {
      chosen.set(child, current);
    } else {
      const latest = [...rs].sort((a, b) => b.effectiveStart.localeCompare(a.effectiveStart));
      const perParent = new Map<string, OwnershipRow>();
      for (const r of latest) if (!perParent.has(r.parentId)) perParent.set(r.parentId, r);
      chosen.set(child, [...perParent.values()]);
    }
  }
  const memo = new Map<string, number>();
  const resolve = (id: string, stack: Set<string>): number => {
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    const parents = chosen.get(id);
    if (!parents) return 100; // a root of the group
    if (stack.has(id)) return 0; // cycle guard
    stack.add(id);
    let pct = 0;
    for (const r of parents) if (r.method !== 'NONE') pct += (r.percent * resolve(r.parentId, stack)) / 100;
    stack.delete(id);
    const v = Math.min(100, pct);
    memo.set(id, v);
    return v;
  };
  const out = new Map<string, number>();
  const ids = new Set<string>([...rows.map((r) => r.parentId), ...rows.map((r) => r.childId)]);
  for (const id of ids) out.set(id, resolve(id, new Set()));
  return out;
}

/** Number of months between two keys inclusive (helper for adapters). */
export function monthSpan(from: MonthKey, to: MonthKey): number {
  return monthIndex(to) - monthIndex(from) + 1;
}
