/**
 * Shared time-series helpers: tooltip rows, point labels and the y-domain.
 * Pure (no React) so the a11y labels and tooltips are tested once.
 */
import { compare, formatDelta, formatValue, fuLabel } from './format';
import { extent } from './scale';
import { longLabel, periodStatus, type ChartUnit, type MetricDirection, type TimeSeriesData, type Value } from './types';
import type { TooltipRow } from './parts';

function isNum(v: Value | undefined): v is number {
  return v !== null && v !== undefined && Number.isFinite(v);
}

export interface SeriesLabels {
  actual?: string;
  priorYear?: string;
  budget?: string;
  ttm?: string;
}

export const DEFAULT_LABELS: Required<SeriesLabels> = { actual: 'Actual', priorYear: 'Prior year', budget: 'Budget', ttm: 'TTM' };

export function statusWord(data: TimeSeriesData, i: number): string | undefined {
  const st = periodStatus(data.periods[i]);
  return st === 'preliminary' ? 'Preliminary' : st === 'forecast' ? 'Forecast' : undefined;
}

/** Tooltip rows for period i: value, PY + YoY, budget + variance F/U, TTM, band. */
export function timeTooltipRows(
  data: TimeSeriesData,
  i: number,
  unit: ChartUnit,
  direction: MetricDirection,
  labels: SeriesLabels = {},
  hidden: (k: string) => boolean = () => false,
): TooltipRow[] {
  const L = { ...DEFAULT_LABELS, ...labels };
  const rows: TooltipRow[] = [];
  const a = data.actual[i];
  const fc = periodStatus(data.periods[i]) === 'forecast';
  rows.push({ label: fc ? 'Forecast' : L.actual, value: isNum(a) ? formatValue(a, unit) : 'Not on file', swatch: fc ? 'dotted' : 'solid', strong: true });
  const py = data.priorYear?.[i];
  if (data.priorYear && !hidden('priorYear')) {
    rows.push({ label: L.priorYear, value: formatValue(py ?? null, unit), swatch: 'dashed' });
    if (isNum(a) && isNum(py)) {
      const c = compare(a, py, direction, unit);
      const fig = unit === 'percent' ? formatDelta(c.delta, unit) : c.rel !== null ? formatValue(c.rel, 'percent', { delta: true }) : 'n/m';
      rows.push({ label: 'vs prior year', value: fig, tone: c.favourable === null ? 'muted' : c.favourable ? 'pos' : 'neg' });
    }
  }
  const b = data.budget?.[i];
  if (data.budget && !hidden('budget')) {
    rows.push({ label: L.budget, value: isNum(b) ? formatValue(b, unit) : 'No budget', swatch: 'tick' });
    if (isNum(a) && isNum(b)) {
      const c = compare(a, b, direction, unit);
      const rel = unit !== 'percent' && b > 0 ? ` · ${formatValue(c.delta / b, 'percent', { delta: true })}` : '';
      const fu = fuLabel(c.favourable);
      rows.push({ label: 'Variance', value: `${formatDelta(c.delta, unit, false)}${rel}${fu ? ` ${fu}` : ''}`, tone: c.favourable === null ? 'muted' : c.favourable ? 'pos' : 'neg' });
    }
  }
  if (data.ttm && !hidden('ttm')) rows.push({ label: L.ttm, value: formatValue(data.ttm[i] ?? null, unit), swatch: 'line' });
  if (data.band && !hidden('band')) {
    const lo = data.band.lo[i];
    const hi = data.band.hi[i];
    if (isNum(lo) && isNum(hi)) rows.push({ label: 'Range', value: `${formatValue(lo, unit, { compact: true })} – ${formatValue(hi, unit, { compact: true })}`, swatch: 'band' });
  }
  return rows;
}

/** The accessible name of a focusable period: "Aug 2026, preliminary: actual $1,240,000; prior year …". */
export function timePointLabel(
  data: TimeSeriesData,
  i: number,
  unit: ChartUnit,
  direction: MetricDirection,
  labels: SeriesLabels = {},
  hidden: (k: string) => boolean = () => false,
): string {
  const st = statusWord(data, i);
  const rows = timeTooltipRows(data, i, unit, direction, labels, hidden);
  return `${longLabel(data.periods[i])}${st ? `, ${st.toLowerCase()}` : ''}: ${rows.map((r) => `${r.label.toLowerCase()} ${r.value}`).join('; ')}`;
}

/** y-extent across the visible series (nulls ignored). */
export function timeExtent(data: TimeSeriesData, hidden: (k: string) => boolean, includeTtm = false): [number, number] {
  const e = extent(
    data.actual,
    hidden('priorYear') ? undefined : data.priorYear,
    hidden('budget') ? undefined : data.budget,
    hidden('band') ? undefined : data.band?.lo,
    hidden('band') ? undefined : data.band?.hi,
    includeTtm && !hidden('ttm') ? data.ttm : undefined,
  );
  return e ?? [0, 1];
}

/** "’26" under January (or the first label) so a 24-month axis shows the year. */
export function yearMarks(data: TimeSeriesData): Array<string | undefined> {
  let lastYear = '';
  return data.periods.map((p) => {
    const m = /(\d{4})/.exec(p.longLabel ?? p.key);
    const y = m ? m[1] : '';
    if (y && y !== lastYear) {
      lastYear = y;
      return `’${y.slice(2)}`;
    }
    return undefined;
  });
}
