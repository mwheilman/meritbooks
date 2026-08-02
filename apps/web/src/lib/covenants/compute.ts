/**
 * Covenant compute engine — PURE, deterministic, unit-tested. No I/O.
 *
 * Canon §3: the deterministic engine does the accounting; AI only explains. This
 * module NEVER calls the model — it takes ledger inputs (bigint cents) already
 * resolved from the owned ledger and computes:
 *   1. the current covenant value (a ratio, or a dollar amount for currency
 *      covenants like minimum-liquidity / tangible-net-worth),
 *   2. its headroom vs the threshold and the pass/WARN/BREACH band, and
 *   3. the PROJECTED breach date — the first forward period whose value crosses the
 *      threshold — walked off the existing cash-forecast trajectory.
 *
 * Money inputs are integer cents. Ratios are plain numbers. A covenant with a
 * missing/zero denominator is "not computable" (value = null) and degrades to
 * band = UNKNOWN rather than throwing — an empty monitor must never break.
 */

export type CovenantType =
  | 'DSCR'
  | 'FCCR'
  | 'LEVERAGE'
  | 'CURRENT_RATIO'
  | 'MIN_LIQUIDITY'
  | 'TNW'
  | 'CUSTOM';

export type CovenantDirection = 'MIN' | 'MAX';

/** How the computed value / threshold should be read. */
export type CovenantUnit = 'RATIO' | 'CURRENCY';

export type CovenantBand = 'PASS' | 'WARN' | 'BREACH' | 'UNKNOWN';

/**
 * Ledger inputs for one measurement period. All money fields are integer cents;
 * a field that doesn't apply to the covenant type may be omitted. The resolver
 * (lib/covenants/ledger.ts) fills these from the GL by role/type.
 */
export interface CovenantInputs {
  /** Trailing EBITDA (already annualized/adjusted upstream), cents. */
  ebitdaCents?: number;
  /** Total debt service for the period: interest + scheduled principal, cents. */
  debtServiceCents?: number;
  /** Fixed charges for FCCR: debt service + rent/lease + other fixed, cents. */
  fixedChargesCents?: number;
  /** Total (or net) funded debt, cents. */
  totalDebtCents?: number;
  /** Current assets, cents. */
  currentAssetsCents?: number;
  /** Current liabilities, cents. */
  currentLiabilitiesCents?: number;
  /** Liquidity = unrestricted cash + revolver availability, cents. */
  liquidityCents?: number;
  /** Tangible net worth = equity − intangibles, cents. */
  tangibleNetWorthCents?: number;
  /** CUSTOM covenant explicit numerator, cents. */
  numeratorCents?: number;
  /** CUSTOM covenant explicit denominator, cents (0 → not computable). */
  denominatorCents?: number;
}

export interface CovenantValue {
  /** The computed value — a ratio, or dollars for currency covenants. null = not computable. */
  value: number | null;
  numeratorCents: number | null;
  denominatorCents: number | null;
  unit: CovenantUnit;
}

export interface CovenantEvaluation extends CovenantValue {
  threshold: number;
  direction: CovenantDirection;
  passed: boolean | null;
  band: CovenantBand;
  /**
   * Signed headroom fraction toward safety:
   *   MIN: (value − threshold) / |threshold|
   *   MAX: (threshold − value) / |threshold|
   * Positive = cushion; negative = breach depth; null when not computable.
   */
  headroomPct: number | null;
  /** Signed distance of value to threshold in value units (positive = safe side). */
  cushion: number | null;
}

const CURRENCY_TYPES: ReadonlySet<CovenantType> = new Set(['MIN_LIQUIDITY', 'TNW']);

/** Round a ratio to 4 dp deterministically (avoids float noise in equality tests). */
function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10_000) / 10_000;
}

/** Default numerator/denominator wiring per covenant type. */
export function computeValue(type: CovenantType, inputs: CovenantInputs): CovenantValue {
  const unit: CovenantUnit = CURRENCY_TYPES.has(type) ? 'CURRENCY' : 'RATIO';

  const ratio = (numCents: number | undefined, denCents: number | undefined): CovenantValue => {
    if (numCents === undefined || denCents === undefined || denCents === 0) {
      return { value: null, numeratorCents: numCents ?? null, denominatorCents: denCents ?? null, unit };
    }
    return { value: round4(numCents / denCents), numeratorCents: numCents, denominatorCents: denCents, unit };
  };

  const currency = (cents: number | undefined): CovenantValue => {
    if (cents === undefined) return { value: null, numeratorCents: null, denominatorCents: null, unit };
    return { value: round4(cents / 100), numeratorCents: cents, denominatorCents: null, unit };
  };

  switch (type) {
    case 'DSCR':
      return ratio(inputs.ebitdaCents, inputs.debtServiceCents);
    case 'FCCR':
      return ratio(inputs.ebitdaCents, inputs.fixedChargesCents);
    case 'LEVERAGE':
      return ratio(inputs.totalDebtCents, inputs.ebitdaCents);
    case 'CURRENT_RATIO':
      return ratio(inputs.currentAssetsCents, inputs.currentLiabilitiesCents);
    case 'MIN_LIQUIDITY':
      return currency(inputs.liquidityCents);
    case 'TNW':
      return currency(inputs.tangibleNetWorthCents);
    case 'CUSTOM':
      return ratio(inputs.numeratorCents, inputs.denominatorCents);
    default: {
      const _never: never = type;
      return _never;
    }
  }
}

/**
 * Pass/fail + headroom for a value against a threshold/direction. `warnPct`
 * (default 0.10) is the headroom fraction below which a passing covenant is WARN.
 */
export function evaluateValue(
  cv: CovenantValue,
  threshold: number,
  direction: CovenantDirection,
  warnPct = 0.1,
): CovenantEvaluation {
  const base: CovenantEvaluation = {
    ...cv,
    threshold,
    direction,
    passed: null,
    band: 'UNKNOWN',
    headroomPct: null,
    cushion: null,
  };

  if (cv.value === null) return base;

  const v = cv.value;
  const passed = direction === 'MIN' ? v >= threshold : v <= threshold;
  const cushion = round4(direction === 'MIN' ? v - threshold : threshold - v);
  const denom = Math.abs(threshold) || 1;
  const headroomPct = round4(cushion / denom);

  let band: CovenantBand;
  if (!passed) band = 'BREACH';
  else if (headroomPct < warnPct) band = 'WARN';
  else band = 'PASS';

  return { ...base, passed, band, headroomPct, cushion };
}

/** One-shot: compute + evaluate a covenant for a single period. */
export function evaluateCovenant(
  type: CovenantType,
  inputs: CovenantInputs,
  threshold: number,
  direction: CovenantDirection,
  warnPct = 0.1,
): CovenantEvaluation {
  return evaluateValue(computeValue(type, inputs), threshold, direction, warnPct);
}

// ── Projected breach off the forecast trajectory ──────────────────────────────

export interface SeriesPoint {
  /** ISO yyyy-mm-dd for the period end. */
  date: string;
  value: number | null;
}

export interface BreachProjection {
  /** First forward period whose value crosses the threshold; null = safe across horizon. */
  breachDate: string | null;
  /** Index into the series of that first breaching period (−1 if none). */
  breachIndex: number;
  /**
   * Interpolated crossing date between the last passing and first breaching
   * point (linear on value vs time), when both are computable — a tighter
   * estimate than the period boundary. Null when not interpolable.
   */
  crossingDate: string | null;
  /** True when the series already starts in breach (period 0). */
  breachedAtStart: boolean;
}

function passesAt(value: number, threshold: number, direction: CovenantDirection): boolean {
  return direction === 'MIN' ? value >= threshold : value <= threshold;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Walk a forward-ordered series of projected covenant values and return the first
 * period that fails the threshold. Deterministic; ignores non-computable points.
 * When the failing point is bracketed by a prior passing point, linearly
 * interpolates the crossing date for a tighter breach estimate.
 */
export function projectBreach(
  series: SeriesPoint[],
  threshold: number,
  direction: CovenantDirection,
): BreachProjection {
  let lastPass: { date: string; value: number } | null = null;

  for (let i = 0; i < series.length; i++) {
    const p = series[i];
    if (p.value === null) continue;
    if (passesAt(p.value, threshold, direction)) {
      lastPass = { date: p.date, value: p.value };
      continue;
    }
    // First breaching period.
    let crossingDate: string | null = null;
    if (lastPass && lastPass.value !== p.value) {
      const t0 = Date.parse(lastPass.date + 'T00:00:00Z');
      const t1 = Date.parse(p.date + 'T00:00:00Z');
      if (Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0) {
        // Fraction of the way from lastPass.value to p.value where we hit threshold.
        const frac = (threshold - lastPass.value) / (p.value - lastPass.value);
        const clamped = Math.min(1, Math.max(0, frac));
        crossingDate = isoDay(t0 + clamped * (t1 - t0));
      }
    }
    return { breachDate: p.date, breachIndex: i, crossingDate, breachedAtStart: i === 0 };
  }

  return { breachDate: null, breachIndex: -1, crossingDate: null, breachedAtStart: false };
}

/**
 * Build a projected value series by applying period cash deltas to the
 * cash-linked input of the covenant, then computing the value each period.
 *
 * The existing 13-week cash forecast yields a projected net-cash change per
 * period. Cash movement flows deterministically into the covenant's cash-sensitive
 * component by type:
 *   - MIN_LIQUIDITY → liquidity moves with cash.
 *   - CURRENT_RATIO → current assets move with cash.
 *   - LEVERAGE      → net debt falls as cash rises (totalDebt − Δcash).
 *   - TNW           → equity moves with cash.
 *   - DSCR / FCCR / CUSTOM → EBITDA/debt-service are trailing and treated flat over
 *     the short horizon (value held constant); breach only if already failing.
 * Each point carries the CUMULATIVE delta from period 0, so a steady cash drain
 * produces a monotonic trajectory the breach walker can cross.
 */
export function buildForecastSeries(
  type: CovenantType,
  base: CovenantInputs,
  threshold: number,
  direction: CovenantDirection,
  periods: { date: string; cumulativeCashDeltaCents: number }[],
): SeriesPoint[] {
  return periods.map((pd) => {
    const shifted: CovenantInputs = { ...base };
    const d = pd.cumulativeCashDeltaCents;
    switch (type) {
      case 'MIN_LIQUIDITY':
        shifted.liquidityCents = (base.liquidityCents ?? 0) + d;
        break;
      case 'CURRENT_RATIO':
        shifted.currentAssetsCents = (base.currentAssetsCents ?? 0) + d;
        break;
      case 'LEVERAGE':
        // More cash → less net debt (and vice-versa).
        shifted.totalDebtCents = (base.totalDebtCents ?? 0) - d;
        break;
      case 'TNW':
        shifted.tangibleNetWorthCents = (base.tangibleNetWorthCents ?? 0) + d;
        break;
      default:
        break; // DSCR / FCCR / CUSTOM held flat over the horizon.
    }
    const cv = computeValue(type, shifted);
    return { date: pd.date, value: cv.value, unit: cv.unit } as SeriesPoint;
  });
}

/** Human labels + accent tones for a band (UI + certificate share one source). */
export const BAND_LABEL: Record<CovenantBand, string> = {
  PASS: 'In compliance',
  WARN: 'Tight — nearing threshold',
  BREACH: 'Out of compliance',
  UNKNOWN: 'Not computable',
};
