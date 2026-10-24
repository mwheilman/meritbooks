/**
 * Seasonality: a 12-month index (1.00 = an average month) from COMPLETE years only,
 * a quarter-share profile, a current-year overlay, and best/worst month.
 *
 * Method: split the series into 12-month blocks aligned to the fiscal-year start. A
 * block is "complete" when all 12 months are on file and its total is positive. For
 * each complete block, divide each month by that block's average month; the index for
 * a calendar month is the mean of those ratios across blocks. Because each block's
 * ratios average exactly 1, the 12 indices average exactly 1.00. Incomplete years are
 * ignored, never padded.
 */

import { addMonths, calendarMonth, calendarYear, compareMonths, fiscalYearStart, monthRange, type MonthKey } from './months';
import { mean } from './numbers';
import { normalizeSeries, seriesMap, type MonthlySeries } from './series';

interface Block {
  /** Fiscal-year label = calendar year of the block's last month. */
  year: number;
  months: MonthKey[];
  values: number[];
  total: number;
}

function completeBlocks(series: MonthlySeries, fyStartMonth: number): { complete: Block[]; skipped: number[] } {
  const norm = normalizeSeries(series);
  if (norm.length === 0) return { complete: [], skipped: [] };
  const map = seriesMap(norm);
  const last = norm[norm.length - 1].month;
  const complete: Block[] = [];
  const skipped: number[] = [];
  for (let start = fiscalYearStart(norm[0].month, fyStartMonth); compareMonths(addMonths(start, 11), last) <= 0; start = addMonths(start, 12)) {
    const months = monthRange(start, addMonths(start, 11));
    const year = calendarYear(months[11]);
    const raw = months.map((m) => map.get(m));
    if (raw.some((v) => v === undefined || v === null)) {
      skipped.push(year);
      continue;
    }
    const values = raw as number[];
    const total = values.reduce((s, v) => s + v, 0);
    if (total <= 0) {
      skipped.push(year);
      continue;
    }
    complete.push({ year, months, values, total });
  }
  return { complete, skipped };
}

export interface SeasonalityIndex {
  /** index[0] = January … index[11] = December (calendar months). null if no complete year. */
  index: (number | null)[];
  /** Fiscal years used (label = calendar year the fiscal year ends in). */
  yearsUsed: number[];
  /** Years skipped: a month missing, a non-positive total, or older than `maxYears`. */
  yearsSkipped: number[];
  /** Average month of the most recent complete year (the overlay's reference). */
  referenceAverage: number | null;
}

/**
 * @param fyStartMonth 12-month blocks start on this calendar month (default January).
 * @param maxYears use at most the most recent N complete years (default 3, as the portal).
 */
export function seasonalityIndex(series: MonthlySeries, opts: { fyStartMonth?: number; maxYears?: number } = {}): SeasonalityIndex {
  const { complete, skipped } = completeBlocks(series, opts.fyStartMonth ?? 1);
  const maxYears = opts.maxYears ?? 3;
  const used = complete.slice(-maxYears);
  const older = complete.slice(0, complete.length - used.length).map((b) => b.year);
  const yearsSkipped = [...skipped, ...older].sort((a, b) => a - b);
  if (used.length === 0) {
    return { index: Array<number | null>(12).fill(null), yearsUsed: [], yearsSkipped, referenceAverage: null };
  }
  const ratios: number[][] = Array.from({ length: 12 }, () => []);
  for (const b of used) {
    const avg = b.total / 12;
    b.months.forEach((m, i) => ratios[calendarMonth(m) - 1].push(b.values[i] / avg));
  }
  const ref = used[used.length - 1];
  return {
    index: ratios.map((r) => mean(r)),
    yearsUsed: used.map((b) => b.year),
    yearsSkipped,
    referenceAverage: ref.total / 12,
  };
}

export interface OverlayPoint {
  month: MonthKey;
  /** The month's value ÷ the reference average month (null for a gap). */
  ratio: number | null;
  /** The seasonal index for that calendar month. */
  expected: number | null;
}

/** The current year against the index, month by month over [from, to]. */
export function seasonalOverlay(series: MonthlySeries, idx: SeasonalityIndex, from: MonthKey, to: MonthKey): OverlayPoint[] {
  const map = seriesMap(normalizeSeries(series));
  const ref = idx.referenceAverage;
  return monthRange(from, to).map((month) => {
    const v = map.get(month);
    return {
      month,
      ratio: ref !== null && ref > 0 && typeof v === 'number' ? v / ref : null,
      expected: idx.index[calendarMonth(month) - 1],
    };
  });
}

/**
 * Each fiscal quarter's share of the year, averaged over complete years. Shares sum
 * to 1 within a year, so the averaged shares also sum to 1.
 */
export function quarterShares(series: MonthlySeries, opts: { fyStartMonth?: number; maxYears?: number } = {}): { shares: (number | null)[]; yearsUsed: number[] } {
  const { complete } = completeBlocks(series, opts.fyStartMonth ?? 1);
  const used = complete.slice(-(opts.maxYears ?? 3));
  if (used.length === 0) return { shares: [null, null, null, null], yearsUsed: [] };
  const perYear = used.map((b) => [0, 1, 2, 3].map((q) => (b.values[q * 3] + b.values[q * 3 + 1] + b.values[q * 3 + 2]) / b.total));
  return {
    shares: [0, 1, 2, 3].map((q) => mean(perYear.map((s) => s[q]))),
    yearsUsed: used.map((b) => b.year),
  };
}

export interface BestWorst {
  best: { month: MonthKey; value: number } | null;
  worst: { month: MonthKey; value: number } | null;
  monthsConsidered: number;
}

/** Best and worst month on file in [from, to]; ties go to the earlier month. */
export function bestWorstMonth(series: MonthlySeries, from: MonthKey, to: MonthKey): BestWorst {
  const map = seriesMap(normalizeSeries(series));
  let best: BestWorst['best'] = null;
  let worst: BestWorst['worst'] = null;
  let n = 0;
  for (const month of monthRange(from, to)) {
    const v = map.get(month);
    if (v === undefined || v === null) continue;
    n += 1;
    if (!best || v > best.value) best = { month, value: v };
    if (!worst || v < worst.value) worst = { month, value: v };
  }
  return { best, worst, monthsConsidered: n };
}
