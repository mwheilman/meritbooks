/**
 * Anomaly flags: z-score of each period against its OWN trailing window (the point
 * under test is excluded from the baseline). Honest by construction:
 *   - needs `minHistory` trailing points on file (gaps are skipped, not zeroed);
 *   - a flat baseline (stdev 0) yields no z-score unless the value differs, in which
 *     case it is flagged with `flatBaseline: true` and z = null.
 */

import { mean, stdev } from './numbers';
import { normalizeSeries, type MonthlySeries } from './series';
import type { MonthKey } from './months';

export interface AnomalyOptions {
  /** Trailing window length (default 12). */
  window?: number;
  /** Minimum on-file points in the window (default 6). */
  minHistory?: number;
  /** |z| at or above which a point is flagged (default 2.5). */
  threshold?: number;
}

export interface AnomalyPoint {
  month: MonthKey;
  value: number | null;
  z: number | null;
  baselineMean: number | null;
  baselineStdev: number | null;
  flagged: boolean;
  direction: 'above' | 'below' | null;
  flatBaseline?: boolean;
  reason?: 'gap' | 'not_enough_history';
}

/** z-score of `value` against `history`; null if fewer than 2 points or no spread. */
export function zScore(value: number, history: readonly number[]): number | null {
  const sd = stdev(history);
  const m = mean(history);
  if (sd === null || m === null || sd === 0) return null;
  return (value - m) / sd;
}

export function detectAnomalies(series: MonthlySeries, opts: AnomalyOptions = {}): AnomalyPoint[] {
  const window = opts.window ?? 12;
  const minHistory = Math.max(2, opts.minHistory ?? 6);
  const threshold = opts.threshold ?? 2.5;
  const norm = normalizeSeries(series);
  return norm.map((p, i) => {
    if (p.value === null) {
      return { month: p.month, value: null, z: null, baselineMean: null, baselineStdev: null, flagged: false, direction: null, reason: 'gap' };
    }
    const history = norm
      .slice(Math.max(0, i - window), i)
      .map((h) => h.value)
      .filter((v): v is number => v !== null);
    if (history.length < minHistory) {
      return { month: p.month, value: p.value, z: null, baselineMean: null, baselineStdev: null, flagged: false, direction: null, reason: 'not_enough_history' };
    }
    const m = mean(history) as number;
    const sd = stdev(history) as number;
    if (sd === 0) {
      const differs = p.value !== m;
      return {
        month: p.month,
        value: p.value,
        z: null,
        baselineMean: m,
        baselineStdev: 0,
        flagged: differs,
        direction: differs ? (p.value > m ? 'above' : 'below') : null,
        flatBaseline: true,
      };
    }
    const z = (p.value - m) / sd;
    const flagged = Math.abs(z) >= threshold;
    return { month: p.month, value: p.value, z, baselineMean: m, baselineStdev: sd, flagged, direction: flagged ? (z > 0 ? 'above' : 'below') : null };
  });
}
