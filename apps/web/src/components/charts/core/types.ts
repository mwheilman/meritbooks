/**
 * Chart kit — the data contract every chart in Books speaks.
 *
 * The rules this file encodes (FEATURE-GAP-AUDIT §4.4, D-PARTNER-PORTAL §2):
 *  - Money is ALWAYS integer cents. Percent values are FRACTIONS (0.131 = 13.1%).
 *  - A missing value is `null` — a gap, never zero. Charts break lines at nulls,
 *    tables print a dash, exports write an empty cell.
 *  - Every period carries a status. Preliminary (books not closed) is hatched;
 *    forecast is dotted. They are different encodings on purpose.
 *  - Direction is semantic ("higher is better" for revenue, "lower is better" for
 *    DSO / opex), so a chart can say "improvement" / "erosion" and colour a
 *    variance favourable / unfavourable without the caller hand-picking colours.
 *
 * Producers (3B metric registry / analytics, 3A report engine) hand these shapes
 * in; see `MetricSeriesLike` + `fromMetricSeries` for the adapter seam.
 */

/** How a number is read. Money = integer cents; percent = fraction. */
export type ChartUnit = 'money' | 'percent' | 'count' | 'ratio' | 'multiple' | 'days' | 'months';

/** Which way is good. Drives improvement/erosion wording and F/U colouring. */
export type MetricDirection = 'higher_is_better' | 'lower_is_better' | 'neutral';

/** closed = final · preliminary = books not closed (hatched) · forecast = projected (dotted). */
export type PeriodStatus = 'closed' | 'preliminary' | 'forecast';

/** A missing value is null — a gap — never zero. */
export type Value = number | null;

export interface ChartPeriod {
  /** Stable key handed back to onDrill (e.g. "2026-08"). */
  key: string;
  /** Short axis label ("Aug"). */
  label: string;
  /** Long label for tooltips, tables and sentences ("Aug 2026"). Defaults to label. */
  longLabel?: string;
  /** Defaults to 'closed'. */
  status?: PeriodStatus;
}

/** Monthly (or any ordered period) series with the standard comparisons. */
export interface TimeSeriesData {
  periods: ChartPeriod[];
  /** The headline series (Electric Blue). */
  actual: Value[];
  /** Same period a year earlier (dashed Midnight line). */
  priorYear?: Value[];
  /** Approved budget (tick marks). */
  budget?: Value[];
  /** Trailing-twelve-month series for the synced sub-panel (never a second axis). */
  ttm?: Value[];
  /** Forecast uncertainty band (fan chart). */
  band?: { lo: Value[]; hi: Value[] };
}

/** A category × series matrix (grouped / stacked bars, aging, heat grid). */
export interface CategorySeries {
  key: string;
  label: string;
  values: Value[];
}

export interface Category {
  key: string;
  label: string;
  /** Secondary line (company kind, account code). */
  sub?: string;
}

/**
 * Why a figure cannot be shown. The kit refuses to invent a number; it names
 * the reason instead (FEATURE-GAP-AUDIT §4.3 "unavailable states").
 */
export type UnavailableReason =
  | 'not_enough_history'
  | 'not_on_file'
  | 'not_mapped'
  | 'not_meaningful'
  | 'no_approved_budget'
  | 'preliminary'
  | 'no_activity';

/**
 * The adapter seam for Wave 3B (`lib/metrics/*`). 3B had not landed when the kit
 * was built, so this is the MINIMAL shape the kit needs; a 3B `MetricSeries`
 * that carries at least these fields plugs straight in via `fromMetricSeries`.
 */
export interface MetricSeriesLike {
  metricId: string;
  label: string;
  unit: ChartUnit;
  direction: MetricDirection;
  points: ReadonlyArray<{
    periodKey: string;
    label: string;
    longLabel?: string;
    status?: PeriodStatus;
    value: Value;
    priorYear?: Value;
    budget?: Value;
    ttm?: Value;
  }>;
  definition?: string;
  unavailable?: UnavailableReason;
}

/** 3B metric series → the kit's TimeSeriesData. Pure. */
export function fromMetricSeries(s: MetricSeriesLike): TimeSeriesData {
  const periods: ChartPeriod[] = s.points.map((p) => ({
    key: p.periodKey,
    label: p.label,
    longLabel: p.longLabel,
    status: p.status ?? 'closed',
  }));
  const pick = (f: (p: MetricSeriesLike['points'][number]) => Value | undefined): Value[] | undefined => {
    const out = s.points.map((p) => f(p));
    return out.some((v) => v !== undefined) ? out.map((v) => (v === undefined ? null : v)) : undefined;
  };
  return {
    periods,
    actual: s.points.map((p) => p.value),
    priorYear: pick((p) => p.priorYear),
    budget: pick((p) => p.budget),
    ttm: pick((p) => p.ttm),
  };
}

/** Period helpers. */
export function periodStatus(p: ChartPeriod | undefined): PeriodStatus {
  return p?.status ?? 'closed';
}
export function longLabel(p: ChartPeriod): string {
  return p.longLabel ?? p.label;
}
