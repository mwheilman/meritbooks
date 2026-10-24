/**
 * Forecast helpers — deliberately simple and honest.
 *
 *   linearForecast  — ordinary least squares trend on the months on file, with a
 *                     prediction interval that widens with distance from the data.
 *   seasonalNaive   — "same month last year" (Hyndman's SNAIVE) with an interval
 *                     from the year-over-year residuals, widening each full season.
 *
 * Both refuse to forecast from too little history (`not_enough_history`). Intervals
 * use the normal approximation (z = 1.2816 for 80%, 1.96 for 95%), stated in the
 * output so a chart footer can say exactly what the band is. Half-widths are
 * non-decreasing in the horizon by construction (FPB AC-K8).
 */

import { addMonths, type MonthKey } from './months';
import { roundCents } from './numbers';
import { normalizeSeries, seriesMap, type MonthlySeries } from './series';

export type Confidence = 0.8 | 0.95;

const Z: Record<Confidence, number> = { 0.8: 1.2816, 0.95: 1.96 };

export interface ForecastPoint {
  month: MonthKey;
  value: number;
  lower: number;
  upper: number;
}

export interface ForecastOk {
  ok: true;
  method: 'linear' | 'seasonal_naive';
  confidence: Confidence;
  points: ForecastPoint[];
  /** Residual standard error the band is built from. */
  sigma: number;
  /** Months of history the model was fitted on. */
  basisMonths: number;
  /** Linear only: slope per month. */
  slopePerMonth?: number;
}

export type ForecastOutcome = ForecastOk | { ok: false; reason: 'not_enough_history'; monthsOnFile: number; needed: number };

export interface ForecastOptions {
  horizon: number;
  confidence?: Confidence;
  /** Round values and bands to integer cents (default true). */
  integer?: boolean;
  /** Minimum observations (default: linear 6, seasonal naive 18). */
  minPoints?: number;
}

function finish(value: number, half: number, integer: boolean): { value: number; lower: number; upper: number } {
  if (!integer) return { value, lower: value - half, upper: value + half };
  const v = roundCents(value);
  const h = roundCents(half);
  return { value: v, lower: v - h, upper: v + h };
}

export function linearForecast(series: MonthlySeries, opts: ForecastOptions): ForecastOutcome {
  const norm = normalizeSeries(series);
  const obs = norm.map((p, i) => ({ x: i, y: p.value })).filter((o): o is { x: number; y: number } => o.y !== null);
  const needed = Math.max(3, opts.minPoints ?? 6);
  if (obs.length < needed) return { ok: false, reason: 'not_enough_history', monthsOnFile: obs.length, needed };
  const n = obs.length;
  const xBar = obs.reduce((s, o) => s + o.x, 0) / n;
  const yBar = obs.reduce((s, o) => s + o.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const o of obs) {
    sxx += (o.x - xBar) ** 2;
    sxy += (o.x - xBar) * (o.y - yBar);
  }
  const slope = sxy / sxx;
  const intercept = yBar - slope * xBar;
  let sse = 0;
  for (const o of obs) sse += (o.y - (intercept + slope * o.x)) ** 2;
  const sigma = Math.sqrt(sse / (n - 2));
  const confidence = opts.confidence ?? 0.8;
  const z = Z[confidence];
  const lastIndex = norm.length - 1;
  const lastMonth = norm[lastIndex].month;
  const integer = opts.integer ?? true;
  const points: ForecastPoint[] = [];
  for (let h = 1; h <= opts.horizon; h++) {
    const x0 = lastIndex + h;
    const half = z * sigma * Math.sqrt(1 + 1 / n + (x0 - xBar) ** 2 / sxx);
    points.push({ month: addMonths(lastMonth, h), ...finish(intercept + slope * x0, half, integer) });
  }
  return { ok: true, method: 'linear', confidence, points, sigma, basisMonths: n, slopePerMonth: slope };
}

export function seasonalNaive(series: MonthlySeries, opts: ForecastOptions & { season?: number }): ForecastOutcome {
  const season = opts.season ?? 12;
  const norm = normalizeSeries(series);
  const map = seriesMap(norm);
  const onFile = norm.filter((p) => p.value !== null).length;
  const needed = Math.max(season + 2, opts.minPoints ?? season + 6);
  if (norm.length === 0 || onFile < needed) return { ok: false, reason: 'not_enough_history', monthsOnFile: onFile, needed };
  const lastMonth = norm[norm.length - 1].month;
  const residuals: number[] = [];
  for (const p of norm) {
    const prev = map.get(addMonths(p.month, -season));
    if (p.value !== null && typeof prev === 'number') residuals.push(p.value - prev);
  }
  if (residuals.length < 2) return { ok: false, reason: 'not_enough_history', monthsOnFile: onFile, needed };
  const sigma = Math.sqrt(residuals.reduce((s, e) => s + e * e, 0) / residuals.length);
  const confidence = opts.confidence ?? 0.8;
  const z = Z[confidence];
  const integer = opts.integer ?? true;
  const points: ForecastPoint[] = [];
  for (let h = 1; h <= opts.horizon; h++) {
    const k = Math.floor((h - 1) / season) + 1;
    // Same calendar month in the last observed season (walk back whole seasons until on file).
    let source: number | null = null;
    for (let back = k; back <= k + 3 && source === null; back++) {
      const v = map.get(addMonths(lastMonth, h - season * back));
      if (typeof v === 'number') source = v;
    }
    if (source === null) return { ok: false, reason: 'not_enough_history', monthsOnFile: onFile, needed };
    points.push({ month: addMonths(lastMonth, h), ...finish(source, z * sigma * Math.sqrt(k), integer) });
  }
  return { ok: true, method: 'seasonal_naive', confidence, points, sigma, basisMonths: residuals.length };
}
