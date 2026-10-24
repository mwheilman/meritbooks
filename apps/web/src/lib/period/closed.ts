/**
 * Close status per month across a set of companies (PURE) — feeds the picker's month grid
 * ("closed" marks) and the "Last 12 closed months" preset.
 *
 * Mirrors number governance (lib/reports/governance/policy.ts `closedThrough`): a company's
 * books are closed through the last month of the CONTIGUOUS run of HARD_CLOSE periods from its
 * first period (a gap or an open month ends the run). For a scope of several companies the
 * scope is closed through the EARLIEST of them — a month is only "closed" when every company
 * in scope has closed it.
 */
import { addMonths, isMonthKey, monthKeyOf, type MonthKey } from './resolve';

export type FiscalPeriodStatus = 'OPEN' | 'SOFT_CLOSE' | 'HARD_CLOSE';
export type MonthCloseState = 'closed' | 'soft' | 'open';

export interface PeriodStatusRow {
  locationId: string;
  year: number;
  month: number;
  status: FiscalPeriodStatus | string;
}

export interface CloseSummary {
  /** Earliest company's contiguous HARD_CLOSE run end; null when any company has none. */
  closedThrough: MonthKey | null;
  /** Per month: closed (every company HARD_CLOSE), soft (every company ≥ SOFT_CLOSE), else open. */
  months: Record<MonthKey, MonthCloseState>;
  companies: number;
}

function rank(status: string): number {
  return status === 'HARD_CLOSE' ? 2 : status === 'SOFT_CLOSE' ? 1 : 0;
}

export function summarizeClose(rows: readonly PeriodStatusRow[]): CloseSummary {
  const byCompany = new Map<string, Map<MonthKey, number>>();
  for (const r of rows) {
    if (!r.locationId || !Number.isInteger(r.year) || !Number.isInteger(r.month) || r.month < 1 || r.month > 12) continue;
    const k = monthKeyOf(r.year, r.month);
    if (!isMonthKey(k)) continue;
    let m = byCompany.get(r.locationId);
    if (!m) byCompany.set(r.locationId, (m = new Map()));
    m.set(k, Math.max(m.get(k) ?? 0, rank(String(r.status))));
  }
  if (byCompany.size === 0) return { closedThrough: null, months: {}, companies: 0 };

  // closed-through per company, then the earliest across the scope.
  let scopeThrough: MonthKey | null = null;
  let anyNone = false;
  for (const months of byCompany.values()) {
    const keys = [...months.keys()].sort();
    let through: MonthKey | null = null;
    let prev: MonthKey | null = null;
    for (const k of keys) {
      if (prev !== null && k !== addMonths(prev, 1)) break;
      if ((months.get(k) ?? 0) < 2) break;
      through = k;
      prev = k;
    }
    if (through === null) anyNone = true;
    else if (scopeThrough === null || through < scopeThrough) scopeThrough = through;
  }

  // Month states: the minimum rank across companies that have a row for the month; a company
  // with no row for a month it should have (inside its own span) counts as open.
  const all = new Set<MonthKey>();
  for (const m of byCompany.values()) for (const k of m.keys()) all.add(k);
  const months: Record<MonthKey, MonthCloseState> = {};
  for (const k of [...all].sort()) {
    let min = 2;
    for (const m of byCompany.values()) min = Math.min(min, m.get(k) ?? 0);
    months[k] = min === 2 ? 'closed' : min === 1 ? 'soft' : 'open';
  }
  return { closedThrough: anyNone ? null : scopeThrough, months, companies: byCompany.size };
}
