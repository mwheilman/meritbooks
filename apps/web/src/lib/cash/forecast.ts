/**
 * 13-Week Cash Forecast — pure projection engine.
 *
 * No I/O. Given a starting cash balance (bank account balances) and the set of
 * open AR inflows / open AP outflows keyed by due date, this buckets each item
 * into one of 13 forward weeks and rolls a weekly opening → net → closing
 * balance so the UI (and the API) share one deterministic, testable model.
 *
 * Money is bigint cents throughout — never floating point.
 *
 * Bucketing rule: week 1 starts on the Monday of the current week, so an item
 * whose due date is today lands in week 1. Anything already past due (due before
 * week 1's Monday) is pulled into week 1 as "expected immediately". Items due
 * beyond the 13-week horizon are excluded from the projection (returned via
 * `beyondHorizonCents` for transparency).
 */

export const HORIZON_WEEKS = 13;

export interface ForecastCashflowItem {
  /** Source row id (invoice/bill) for drill-down. */
  id: string;
  /** ISO date (yyyy-mm-dd) the cash is expected to move. */
  dueDate: string;
  /** Positive cents. Inflows and outflows are both stored positive. */
  amountCents: number;
  /** Document number, e.g. invoice / bill number. */
  label: string;
  /** Counterparty name (customer for AR, vendor for AP). */
  party: string;
  /** Source status (e.g. SENT, OVERDUE, APPROVED). */
  status: string;
  /** True when the due date is already past (informational badge). */
  overdue: boolean;
}

export interface ForecastWeek {
  index: number; // 0-based
  weekNumber: number; // 1-based, for display
  startDate: string; // ISO yyyy-mm-dd (Monday)
  endDate: string; // ISO yyyy-mm-dd (Sunday)
  openingCents: number;
  inflowsCents: number;
  outflowsCents: number;
  netCents: number;
  closingCents: number;
  /** Heuristic model-confidence band (%) — degrades further out. */
  confidence: number;
  inflowItems: ForecastCashflowItem[];
  outflowItems: ForecastCashflowItem[];
}

export interface ForecastResult {
  anchorDate: string; // ISO Monday of week 1
  startingCashCents: number;
  endingCashCents: number;
  weeks: ForecastWeek[];
  /** Lowest projected closing balance across the horizon. */
  lowWaterMarkCents: number;
  /** Week index of the low-water mark (-1 if the low is the start balance). */
  lowWaterWeekIndex: number;
  /** How many weeks end with a negative projected balance. */
  negativeWeekCount: number;
  totalInflowsCents: number;
  totalOutflowsCents: number;
  /** Cash due outside the 13-week window (not projected). */
  beyondHorizonInflowsCents: number;
  beyondHorizonOutflowsCents: number;
}

/** UTC midnight of the Monday on or before `date`. */
export function mondayOf(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dow = d.getUTCDay(); // 0=Sun .. 6=Sat
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Parse an ISO date (yyyy-mm-dd) as UTC midnight; tolerant of timestamps. */
export function parseIsoDate(s: string): Date {
  const datePart = s.slice(0, 10);
  const [y, m, d] = datePart.split('-').map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
}

/**
 * Returns the 0-based week index for a due date given the week-1 Monday anchor,
 * or -1 when the item falls beyond the 13-week horizon. Past-due → week 0.
 */
export function bucketIndex(dueDate: string, anchor: Date): number {
  const due = parseIsoDate(dueDate);
  if (due.getTime() < anchor.getTime()) return 0;
  const diffDays = Math.floor((due.getTime() - anchor.getTime()) / 86_400_000);
  const idx = Math.floor(diffDays / 7);
  return idx < HORIZON_WEEKS ? idx : -1;
}

function confidenceFor(weekIndex: number): number {
  // Near-term commitments are firmer than distant ones. Bands only — surfaced
  // to the user as directional, not a statistical guarantee.
  if (weekIndex < 2) return 92;
  if (weekIndex < 6) return 78;
  return 64;
}

export interface BuildForecastParams {
  startingCashCents: number;
  inflows: ForecastCashflowItem[];
  outflows: ForecastCashflowItem[];
  /** Override "now" (tests). Defaults to current date. */
  today?: Date;
}

export function buildForecast(params: BuildForecastParams): ForecastResult {
  const anchor = mondayOf(params.today ?? new Date());

  const weeks: ForecastWeek[] = [];
  for (let i = 0; i < HORIZON_WEEKS; i++) {
    const start = addDays(anchor, i * 7);
    const end = addDays(start, 6);
    weeks.push({
      index: i,
      weekNumber: i + 1,
      startDate: isoDate(start),
      endDate: isoDate(end),
      openingCents: 0,
      inflowsCents: 0,
      outflowsCents: 0,
      netCents: 0,
      closingCents: 0,
      confidence: confidenceFor(i),
      inflowItems: [],
      outflowItems: [],
    });
  }

  let beyondInflows = 0;
  let beyondOutflows = 0;

  for (const item of params.inflows) {
    const b = bucketIndex(item.dueDate, anchor);
    if (b < 0) {
      beyondInflows += item.amountCents;
      continue;
    }
    weeks[b].inflowsCents += item.amountCents;
    weeks[b].inflowItems.push(item);
  }
  for (const item of params.outflows) {
    const b = bucketIndex(item.dueDate, anchor);
    if (b < 0) {
      beyondOutflows += item.amountCents;
      continue;
    }
    weeks[b].outflowsCents += item.amountCents;
    weeks[b].outflowItems.push(item);
  }

  let balance = params.startingCashCents;
  let low = params.startingCashCents;
  let lowIdx = -1;
  let negCount = 0;

  for (const w of weeks) {
    w.openingCents = balance;
    w.netCents = w.inflowsCents - w.outflowsCents;
    w.closingCents = balance + w.netCents;
    balance = w.closingCents;

    w.inflowItems.sort((a, b) => b.amountCents - a.amountCents);
    w.outflowItems.sort((a, b) => b.amountCents - a.amountCents);

    if (w.closingCents < low) {
      low = w.closingCents;
      lowIdx = w.index;
    }
    if (w.closingCents < 0) negCount += 1;
  }

  const totalInflows = weeks.reduce((s, w) => s + w.inflowsCents, 0);
  const totalOutflows = weeks.reduce((s, w) => s + w.outflowsCents, 0);

  return {
    anchorDate: isoDate(anchor),
    startingCashCents: params.startingCashCents,
    endingCashCents: balance,
    weeks,
    lowWaterMarkCents: low,
    lowWaterWeekIndex: lowIdx,
    negativeWeekCount: negCount,
    totalInflowsCents: totalInflows,
    totalOutflowsCents: totalOutflows,
    beyondHorizonInflowsCents: beyondInflows,
    beyondHorizonOutflowsCents: beyondOutflows,
  };
}
