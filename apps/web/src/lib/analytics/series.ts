/**
 * Monthly series — the common currency of the analytics library.
 *
 * A point's value is `null` when the month is NOT ON FILE (a gap). A gap is never
 * a zero: rolling sums and growth rates that would need a missing month return
 * null rather than silently treating it as 0.
 */

import { addMonths, compareMonths, monthRange, type MonthKey } from './months';

export interface SeriesPoint {
  month: MonthKey;
  value: number | null;
}

export type MonthlySeries = SeriesPoint[];

/** Index a series by month for O(1) lookup. */
export function seriesMap(series: MonthlySeries): Map<MonthKey, number | null> {
  const map = new Map<MonthKey, number | null>();
  for (const p of series) map.set(p.month, p.value);
  return map;
}

/** Value at `month`; undefined months are gaps (null). */
export function valueAt(series: MonthlySeries | Map<MonthKey, number | null>, month: MonthKey): number | null {
  const map = series instanceof Map ? series : seriesMap(series);
  const v = map.get(month);
  return v === undefined ? null : v;
}

/** Sort ascending by month and fill any interior missing months with explicit gaps. */
export function normalizeSeries(series: MonthlySeries): MonthlySeries {
  if (series.length === 0) return [];
  const sorted = [...series].sort((a, b) => compareMonths(a.month, b.month));
  const map = seriesMap(sorted);
  return monthRange(sorted[0].month, sorted[sorted.length - 1].month).map((month) => ({
    month,
    value: map.get(month) ?? null,
  }));
}

/** Sum of `months` values; null if ANY month is a gap. */
export function windowSum(map: Map<MonthKey, number | null>, months: readonly MonthKey[]): number | null {
  let s = 0;
  for (const m of months) {
    const v = map.get(m);
    if (v === undefined || v === null) return null;
    s += v;
  }
  return s;
}

/** Rolling `n`-month sum at every month of the series (null until n months are on file). */
export function rollingSum(series: MonthlySeries, n: number): MonthlySeries {
  const norm = normalizeSeries(series);
  const map = seriesMap(norm);
  return norm.map((p) => ({
    month: p.month,
    value: windowSum(map, monthRange(addMonths(p.month, -(n - 1)), p.month)),
  }));
}

/** Trailing-twelve-month series. */
export function ttmSeries(series: MonthlySeries): MonthlySeries {
  return rollingSum(series, 12);
}

/** Restrict a series to [from, to], emitting explicit gaps for missing months. */
export function sliceSeries(series: MonthlySeries, from: MonthKey, to: MonthKey): MonthlySeries {
  const map = seriesMap(series);
  return monthRange(from, to).map((month) => ({ month, value: map.get(month) ?? null }));
}

/** Months on file (non-null). */
export function monthsOnFile(series: MonthlySeries): number {
  return series.filter((p) => p.value !== null).length;
}
