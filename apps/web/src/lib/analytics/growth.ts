/**
 * Growth analytics: MoM / YoY series, the YoY table (Month · FYTD · TTM), and the
 * CAGR ladder on a TTM-to-TTM basis (which removes seasonality from the endpoints).
 *
 * Dollar rows change in % (n/m on a base ≤ 0 or a sign flip). Margin rows change
 * in POINTS — a margin moving from 20% to 23% is "+3.0 pts", not "+15%".
 */

import { addMonths, fiscalYearStart, monthRange, type MonthKey } from './months';
import { cagr, growthRate, roundTo, type NotMeaningfulReason } from './numbers';
import { normalizeSeries, seriesMap, windowSum, type MonthlySeries } from './series';

export interface GrowthPoint {
  month: MonthKey;
  value: number | null;
  reason?: NotMeaningfulReason | 'gap';
}

function lagGrowth(series: MonthlySeries, lag: number): GrowthPoint[] {
  const norm = normalizeSeries(series);
  const map = seriesMap(norm);
  return norm.map((p) => {
    const base = map.get(addMonths(p.month, -lag));
    if (p.value === null || base === undefined || base === null) {
      return { month: p.month, value: null, reason: 'gap' };
    }
    const r = growthRate(p.value, base);
    return r.value === null
      ? { month: p.month, value: null, reason: r.reason }
      : { month: p.month, value: r.value };
  });
}

/** Month over month growth (fraction). */
export function momSeries(series: MonthlySeries): GrowthPoint[] {
  return lagGrowth(series, 1);
}

/** Each month vs the same month a year earlier (fraction). */
export function yoySeries(series: MonthlySeries): GrowthPoint[] {
  return lagGrowth(series, 12);
}

export interface YoyCell {
  current: number | null;
  prior: number | null;
  /** current − prior (cents for dollar rows; fraction points for margin rows). */
  change: number | null;
  /** % change for dollar rows (null = n/m); always null for margin rows. */
  pct: number | null;
  /** Points change for margin rows (e.g. 3.0 = +3 pts); null for dollar rows. */
  points: number | null;
  reason?: NotMeaningfulReason | 'gap';
}

export interface YoyRow {
  month: YoyCell;
  fytd: YoyCell;
  ttm: YoyCell;
}

interface Windows {
  month: [MonthKey[], MonthKey[]];
  fytd: [MonthKey[], MonthKey[]];
  ttm: [MonthKey[], MonthKey[]];
}

function windowsFor(periodEnd: MonthKey, fyStartMonth: number): Windows {
  const fyStart = fiscalYearStart(periodEnd, fyStartMonth);
  const fytd = monthRange(fyStart, periodEnd);
  const ttm = monthRange(addMonths(periodEnd, -11), periodEnd);
  const shift = (ms: MonthKey[]) => ms.map((m) => addMonths(m, -12));
  return {
    month: [[periodEnd], [addMonths(periodEnd, -12)]],
    fytd: [fytd, shift(fytd)],
    ttm: [ttm, shift(ttm)],
  };
}

function dollarCell(current: number | null, prior: number | null): YoyCell {
  if (current === null || prior === null) {
    return { current, prior, change: null, pct: null, points: null, reason: 'gap' };
  }
  const g = growthRate(current, prior);
  return {
    current,
    prior,
    change: current - prior,
    pct: g.value === null ? null : roundTo(g.value * 100, 1),
    points: null,
    ...(g.value === null ? { reason: g.reason } : {}),
  };
}

/** YoY row for a dollar line (revenue, EBITDA…). */
export function yoyDollarRow(series: MonthlySeries, periodEnd: MonthKey, fyStartMonth = 1): YoyRow {
  const map = seriesMap(normalizeSeries(series));
  const w = windowsFor(periodEnd, fyStartMonth);
  const cell = ([cur, pri]: [MonthKey[], MonthKey[]]) => dollarCell(windowSum(map, cur), windowSum(map, pri));
  return { month: cell(w.month), fytd: cell(w.fytd), ttm: cell(w.ttm) };
}

/**
 * YoY row for a margin line = numerator ÷ denominator over each window (e.g. gross
 * profit ÷ revenue). Margins compare in points; a window whose denominator ≤ 0 is n/m.
 */
export function yoyMarginRow(
  numerator: MonthlySeries,
  denominator: MonthlySeries,
  periodEnd: MonthKey,
  fyStartMonth = 1,
): YoyRow {
  const nm = seriesMap(normalizeSeries(numerator));
  const dm = seriesMap(normalizeSeries(denominator));
  const w = windowsFor(periodEnd, fyStartMonth);
  const margin = (ms: MonthKey[]): number | null => {
    const n = windowSum(nm, ms);
    const d = windowSum(dm, ms);
    if (n === null || d === null || d <= 0) return null;
    return n / d;
  };
  const cell = ([cur, pri]: [MonthKey[], MonthKey[]]): YoyCell => {
    const c = margin(cur);
    const p = margin(pri);
    if (c === null || p === null) return { current: c, prior: p, change: null, pct: null, points: null, reason: 'gap' };
    return { current: c, prior: p, change: c - p, pct: null, points: roundTo((c - p) * 100, 1) };
  };
  return { month: cell(w.month), fytd: cell(w.fytd), ttm: cell(w.ttm) };
}

export interface CagrRung {
  years: number;
  value: number | null;
  startTtm: number | null;
  endTtm: number | null;
  reason?: 'not_enough_history' | NotMeaningfulReason;
}

/**
 * CAGR ladder (default 1/3/5 years) TTM-to-TTM: the trailing twelve months ending at
 * `periodEnd` vs the trailing twelve months ending `years` earlier.
 */
export function cagrLadder(series: MonthlySeries, periodEnd: MonthKey, rungs: readonly number[] = [1, 3, 5]): CagrRung[] {
  const map = seriesMap(normalizeSeries(series));
  const ttmAt = (end: MonthKey) => windowSum(map, monthRange(addMonths(end, -11), end));
  const endTtm = ttmAt(periodEnd);
  return rungs.map((years) => {
    const startTtm = ttmAt(addMonths(periodEnd, -12 * years));
    if (endTtm === null || startTtm === null) {
      return { years, value: null, startTtm, endTtm, reason: 'not_enough_history' as const };
    }
    const r = cagr(endTtm, startTtm, years);
    return r.value === null
      ? { years, value: null, startTtm, endTtm, reason: r.reason }
      : { years, value: r.value, startTtm, endTtm };
  });
}
