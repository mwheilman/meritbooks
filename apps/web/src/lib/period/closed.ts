/**
 * THE close-status resolver (PURE). Every surface that says whether a month is closed — the
 * period picker's month grid and "Last 12 closed months" preset, number governance
 * (lib/reports/governance/policy.ts `closedThrough`: report engine footnotes, Freshness tab,
 * reporting calendar), and the budget department view — reads it from here, so they can never
 * contradict each other.
 *
 * Per month (fiscal_periods.status, migration 004) the plain-English states are:
 *   OPEN → "Open" · SOFT_CLOSE → "Soft-closed" · HARD_CLOSE → "Closed"
 * and number governance adds "Released" (published to partners) on top of a closed month.
 *
 * "Books closed through M" (one company): the last month of the contiguous run of closed months
 * that starts at the company's FIRST closed month. Months before the first close that are still
 * open (typically calendar months set up before the books went live) do not stop the run — they
 * are reported separately as `openBefore` so the UI can say "Books closed through Dec 2025 ·
 * 12 earlier months still open" instead of the self-contradicting "no month closed yet" next to
 * a year of closed months. Once the run has started, a gap (missing month) or a not-closed month
 * ends it — a reopened month pulls "closed through" back.
 *
 * For a scope of several companies the scope is closed through the EARLIEST of them — a month is
 * only "closed" when every company in scope has closed it.
 */
import { addMonths, isMonthKey, monthKeyOf, monthLabel, type MonthKey } from './resolve';

export type FiscalPeriodStatus = 'OPEN' | 'SOFT_CLOSE' | 'HARD_CLOSE';
export type MonthCloseState = 'closed' | 'soft' | 'open';
/** Display states (governance adds `released` on top of `closed`). */
export type CloseDisplayState = MonthCloseState | 'released';

/** The one plain-English vocabulary for close states. */
export const CLOSE_STATE_LABEL: Record<CloseDisplayState, string> = {
  open: 'Open',
  soft: 'Soft-closed',
  closed: 'Closed',
  released: 'Released',
};

export interface PeriodStatusRow {
  locationId: string;
  year: number;
  month: number;
  status: FiscalPeriodStatus | string;
}

export interface CloseSummary {
  /** Earliest company's closed-through; null when any company in scope has closed nothing. */
  closedThrough: MonthKey | null;
  /** Per month: closed (every company HARD_CLOSE), soft (every company ≥ SOFT_CLOSE), else open. */
  months: Record<MonthKey, MonthCloseState>;
  companies: number;
  /** Months on or before `closedThrough` that are still not closed for some company in scope. */
  openBefore: MonthKey[];
}

export type CloseMinimum = 'HARD_CLOSE' | 'SOFT_CLOSE';

export function closeRank(status: string | null | undefined): number {
  return status === 'HARD_CLOSE' ? 2 : status === 'SOFT_CLOSE' ? 1 : 0;
}

/** fiscal_periods.status → the display state (unknown / missing → open). */
export function closeStateOf(status: string | null | undefined): MonthCloseState {
  const r = closeRank(status);
  return r === 2 ? 'closed' : r === 1 ? 'soft' : 'open';
}

/** fiscal_periods.status → "Closed" / "Soft-closed" / "Open" ("No period" when absent). */
export function closeStatusLabel(status: string | null | undefined): string {
  if (status === 'NO_PERIOD' || status == null) return 'No period';
  return CLOSE_STATE_LABEL[closeStateOf(status)];
}

export interface CompanyCloseRun {
  closedThrough: MonthKey | null;
  /** Months before `closedThrough` that are not closed (open months before the first close). */
  openBefore: MonthKey[];
}

/**
 * One company's closed-through over its periods (any order). `minimum` SOFT_CLOSE gives the
 * "actuals locked through" variant the latest-estimate forecast uses; the default HARD_CLOSE is
 * "books closed through".
 */
export function companyCloseRun(
  periods: Iterable<{ key: MonthKey; status: string | null | undefined }>,
  minimum: CloseMinimum = 'HARD_CLOSE',
): CompanyCloseRun {
  const need = minimum === 'HARD_CLOSE' ? 2 : 1;
  const byKey = new Map<MonthKey, number>();
  for (const p of periods) {
    if (!isMonthKey(p.key)) continue;
    byKey.set(p.key, Math.max(byKey.get(p.key) ?? 0, closeRank(p.status)));
  }
  const keys = [...byKey.keys()].sort();
  const first = keys.findIndex((k) => (byKey.get(k) ?? 0) >= need);
  if (first < 0) return { closedThrough: null, openBefore: [] };
  let through: MonthKey = keys[first];
  for (let i = first + 1; i < keys.length; i++) {
    const k = keys[i];
    if (k !== addMonths(through, 1)) break; // a gap ends the run
    if ((byKey.get(k) ?? 0) < need) break; // a not-closed (or reopened) month ends it
    through = k;
  }
  return { closedThrough: through, openBefore: keys.slice(0, first) };
}

/** Plain-English "closed through" line, shared by the picker legend and governance annotations. */
export function closedThroughText(closedThrough: MonthKey | null, openBefore: number = 0): string {
  if (!closedThrough) return 'No month is closed yet';
  const tail = openBefore > 0 ? ` · ${openBefore} earlier month${openBefore === 1 ? '' : 's'} still open` : '';
  return `Books closed through ${monthLabel(closedThrough)}${tail}`;
}

/** The "Last 12 closed months" preset only means that when something is closed. */
export function lastClosedPresetLabel(closedThrough: MonthKey | null | undefined): string {
  return closedThrough && isMonthKey(closedThrough) ? 'Last 12 closed months' : 'Last 12 months';
}

export function summarizeClose(rows: readonly PeriodStatusRow[]): CloseSummary {
  const byCompany = new Map<string, Map<MonthKey, number>>();
  for (const r of rows) {
    if (!r.locationId || !Number.isInteger(r.year) || !Number.isInteger(r.month) || r.month < 1 || r.month > 12) continue;
    const k = monthKeyOf(r.year, r.month);
    if (!isMonthKey(k)) continue;
    let m = byCompany.get(r.locationId);
    if (!m) byCompany.set(r.locationId, (m = new Map()));
    m.set(k, Math.max(m.get(k) ?? 0, closeRank(String(r.status))));
  }
  if (byCompany.size === 0) return { closedThrough: null, months: {}, companies: 0, openBefore: [] };

  // closed-through per company, then the earliest across the scope.
  let scopeThrough: MonthKey | null = null;
  let anyNone = false;
  for (const months of byCompany.values()) {
    const run = companyCloseRun([...months.entries()].map(([key, rank]) => ({ key, status: rank === 2 ? 'HARD_CLOSE' : rank === 1 ? 'SOFT_CLOSE' : 'OPEN' })));
    if (run.closedThrough === null) anyNone = true;
    else if (scopeThrough === null || run.closedThrough < scopeThrough) scopeThrough = run.closedThrough;
  }

  // Month states: the minimum rank across companies; a company with no row counts as open.
  const all = new Set<MonthKey>();
  for (const m of byCompany.values()) for (const k of m.keys()) all.add(k);
  const months: Record<MonthKey, MonthCloseState> = {};
  for (const k of [...all].sort()) {
    let min = 2;
    for (const m of byCompany.values()) min = Math.min(min, m.get(k) ?? 0);
    months[k] = min === 2 ? 'closed' : min === 1 ? 'soft' : 'open';
  }
  const closedThrough = anyNone ? null : scopeThrough;
  const openBefore = closedThrough ? Object.keys(months).filter((k) => k < closedThrough && months[k] !== 'closed') : [];
  return { closedThrough, months, companies: byCompany.size, openBefore };
}
