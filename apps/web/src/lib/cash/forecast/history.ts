/**
 * Historical cash (fixes the trend — AC-CF10) and runway / burn (B5, B6) — pure.
 *
 * BOOK series: the posted GL cash balance at each date (canonical book cash, lib/cash/book-cash),
 * computed forward from the ledger — NOT rewound from today's bank balance.
 * BANK series: the bank feed's view, rewound from the current feed balance through the dated feed
 * (closing(D) = current − Σ feed amounts after D). The per-point difference (book − bank) is the
 * reconciling gap (outstanding checks, deposits in transit, unposted feed lines, stale feeds).
 */

import { cashSeries, type CashLine } from '@/lib/cash/book-cash';
import { addDays, addMonths, endOfMonth, mondayOf, startOfMonth } from './dates';

export interface BankFeedTxn {
  date: string;
  /** Signed: + money in, − money out. */
  amountCents: number;
}

export interface HistoryPoint {
  date: string;
  bookCents: number | null;
  bankCents: number | null;
  diffCents: number | null;
}

export type HistoryGrain = 'day' | 'week' | 'month';

/** Point dates (oldest → newest) ending today: daily N days, weekly N week-ends (Sundays + today), month-ends. */
export function historyDates(today: string, grain: HistoryGrain, n: number): string[] {
  const out: string[] = [];
  if (grain === 'day') {
    for (let i = n - 1; i >= 0; i--) out.push(addDays(today, -i));
    return out;
  }
  if (grain === 'week') {
    // Each completed week's Sunday, then today.
    const thisMonday = mondayOf(today);
    for (let i = n - 1; i >= 1; i--) out.push(addDays(thisMonday, -7 * (i - 1) - 1));
    out.push(today);
    return out;
  }
  for (let i = n - 1; i >= 1; i--) out.push(endOfMonth(addMonths(startOfMonth(today), -i)));
  out.push(today);
  return out;
}

export function bankSeries(currentCents: number | null, txns: readonly BankFeedTxn[], dates: readonly string[]): Array<number | null> {
  if (currentCents === null) return dates.map(() => null);
  const sorted = txns
    .filter((t) => Number.isFinite(t.amountCents))
    .map((t) => ({ d: t.date.slice(0, 10), a: Math.round(t.amountCents) }))
    .sort((a, b) => (a.d < b.d ? -1 : 1));
  return dates.map((date) => {
    let after = 0;
    for (let i = sorted.length - 1; i >= 0 && sorted[i].d > date; i--) after += sorted[i].a;
    return currentCents - after;
  });
}

export function buildCashHistory(input: {
  lines: readonly CashLine[];
  cashIds: ReadonlySet<string>;
  dates: readonly string[];
  locationIds?: readonly string[] | null;
  bankCurrentCents: number | null;
  bankTxns: readonly BankFeedTxn[];
  /** Earliest date the feed covers — bank points before it are null (no data, not zero). */
  bankFeedStart?: string | null;
  /** May this point be shown (governance)? Withheld book points become null. */
  shown?: (date: string) => boolean;
}): { points: HistoryPoint[]; summary: { startCents: number | null; endCents: number | null; changeCents: number | null; minCents: number | null; maxCents: number | null; lastDiffCents: number | null } } {
  const book = cashSeries(input.lines, input.cashIds, input.dates, input.locationIds);
  const bank = bankSeries(input.bankCurrentCents, input.bankTxns, input.dates);
  const points: HistoryPoint[] = input.dates.map((date, i) => {
    const ok = input.shown ? input.shown(date) : true;
    const b = ok ? book[i] : null;
    const k = input.bankFeedStart && date < input.bankFeedStart ? null : bank[i];
    return { date, bookCents: b, bankCents: k, diffCents: b !== null && k !== null ? b - k : null };
  });
  const vals = points.map((p) => p.bookCents).filter((v): v is number => v !== null);
  const first = points.find((p) => p.bookCents !== null)?.bookCents ?? null;
  const lastP = [...points].reverse().find((p) => p.bookCents !== null);
  const last = lastP?.bookCents ?? null;
  return {
    points,
    summary: {
      startCents: first,
      endCents: last,
      changeCents: first !== null && last !== null ? last - first : null,
      minCents: vals.length ? Math.min(...vals) : null,
      maxCents: vals.length ? Math.max(...vals) : null,
      lastDiffCents: [...points].reverse().find((p) => p.diffCents !== null)?.diffCents ?? null,
    },
  };
}

export interface RunwayResult {
  cashCents: number;
  availableLinesCents: number;
  liquidityCents: number;
  /** Mean monthly decline over the last 3 complete months (positive = burning); null = not enough history. */
  trailingBurnCents: number | null;
  /** −(13-week net change) ÷ 3 (positive = burning). */
  forecastBurnCents: number;
  trailingRunwayMonths: number | null;
  forecastRunwayMonths: number | null;
  trailingState: 'BURNING' | 'GENERATING' | 'NOT_ENOUGH_HISTORY';
  forecastState: 'BURNING' | 'GENERATING';
  zeroCashDate: string | null;
}

/**
 * Runway. `monthEnds` = book cash at the last 4 month-ends (oldest → newest) — 3 deltas. A
 * cash-generative company has no runway ("Cash-generative"), never a negative one.
 */
export function computeRunway(input: {
  cashCents: number;
  monthEnds: ReadonlyArray<number | null>;
  forecastNetCents: number;
  availableLinesCents: number;
  zeroCashDate: string | null;
}): RunwayResult {
  const ends = input.monthEnds;
  let trailing: number | null = null;
  if (ends.length >= 2 && ends.every((v) => v !== null)) {
    const deltas: number[] = [];
    for (let i = 1; i < ends.length; i++) deltas.push((ends[i] as number) - (ends[i - 1] as number));
    trailing = Math.round(-deltas.reduce((s, d) => s + d, 0) / deltas.length);
  }
  const forecastBurn = Math.round(-input.forecastNetCents / 3);
  const months = (burn: number | null) => (burn !== null && burn > 0 ? Math.round((Math.max(0, input.cashCents) / burn) * 10) / 10 : null);
  return {
    cashCents: input.cashCents,
    availableLinesCents: input.availableLinesCents,
    liquidityCents: input.cashCents + input.availableLinesCents,
    trailingBurnCents: trailing,
    forecastBurnCents: forecastBurn,
    trailingRunwayMonths: months(trailing),
    forecastRunwayMonths: months(forecastBurn),
    trailingState: trailing === null ? 'NOT_ENOUGH_HISTORY' : trailing > 0 ? 'BURNING' : 'GENERATING',
    forecastState: forecastBurn > 0 ? 'BURNING' : 'GENERATING',
    zeroCashDate: input.zeroCashDate,
  };
}
