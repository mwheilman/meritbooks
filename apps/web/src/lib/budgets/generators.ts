/**
 * Budget generators (Wave 4B) — pure, integer cents, no I/O. docs/FPB-reports-fpna.md §4.11, AC-B13.
 *
 * Every generator returns 12 monthly amounts (period 1..12) whose sum equals the stated annual
 * total EXACTLY: spreads use largest-remainder allocation, scaled shapes use sign-preserving
 * rounding (3B's analytics library). Amounts are natural sign (revenue and expense positive).
 */
import { allocateCents, roundCents, roundPreservingSum, sum } from '@/lib/analytics';
import type { DriverMethod, DriverSpec } from './types';

export const MONTHS = 12;

export interface GeneratorContext {
  /** Prior fiscal year actuals for this row, periods 1..12. */
  pyMonths?: readonly number[];
  /** Prior fiscal year budget for this row, periods 1..12. */
  priorBudgetMonths?: readonly number[];
  /** This version's budgeted revenue for the department (or company), periods 1..12. */
  revenueMonths?: readonly number[];
}

export interface Generated {
  months: number[];
  annualCents: number;
  /** One plain sentence: how the number was built ("Last year 120,000 + 5.0% = 126,000, last year's monthly shape"). */
  explain: string;
  /** True when the requested shape was unavailable and an even spread was used instead. */
  fellBackToEven: boolean;
}

export class GeneratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeneratorError';
  }
}

const zeros = (): number[] => Array.from({ length: MONTHS }, () => 0);

function months12(xs: readonly number[] | undefined): number[] {
  const out = zeros();
  if (!xs) return out;
  for (let i = 0; i < MONTHS; i++) out[i] = Number.isFinite(xs[i]) ? Math.round(xs[i]) : 0;
  return out;
}

function assertInt(n: number, what: string): void {
  if (!Number.isInteger(n)) throw new GeneratorError(`${what} must be a whole number of cents`);
}

function money(c: number): string {
  const neg = c < 0;
  const s = (Math.abs(c) / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
  return neg ? `(${s})` : s;
}

function pctText(bps: number): string {
  return `${(bps / 100).toFixed(1)}%`;
}

/** Spread an annual total evenly across 12 months (largest remainder: early months take the extra cents). */
export function spreadEven(annualCents: number): number[] {
  assertInt(annualCents, 'Annual amount');
  return allocateCents(annualCents, Array.from({ length: MONTHS }, () => 1));
}

/**
 * Seasonality weights from a 12-month shape: usable only when every month is ≥ 0 and the year is
 * positive. Returns null when the shape can't be used (the caller falls back to an even spread).
 */
export function seasonalWeights(shape: readonly number[] | undefined): number[] | null {
  const s = months12(shape);
  if (s.some((v) => v < 0)) return null;
  if (sum(s) <= 0) return null;
  return s;
}

/** Spread an annual total by a 12-month shape; even when the shape is unusable. */
export function spreadByShape(annualCents: number, shape: readonly number[] | undefined): { months: number[]; fellBackToEven: boolean } {
  assertInt(annualCents, 'Annual amount');
  const w = seasonalWeights(shape);
  if (!w) return { months: spreadEven(annualCents), fellBackToEven: true };
  return { months: allocateCents(annualCents, w), fellBackToEven: false };
}

/** Scale a 12-month series by (1 + bps/10000); months keep their sign and shape, the total ties. */
export function growSeries(base: readonly number[], growthBps: number): number[] {
  if (!Number.isInteger(growthBps)) throw new GeneratorError('Growth must be whole basis points');
  const b = months12(base);
  const factor = 1 + growthBps / 10000;
  const target = roundCents(sum(b) * factor);
  return roundPreservingSum(b.map((v) => v * factor), target);
}

function done(months: number[], explain: string, fellBackToEven = false): Generated {
  return { months, annualCents: sum(months), explain, fellBackToEven };
}

/** Expand one driver into 12 months. */
export function generate(spec: DriverSpec, ctx: GeneratorContext = {}): Generated {
  switch (spec.method) {
    case 'FIXED_MONTHLY': {
      assertInt(spec.monthlyCents, 'Monthly amount');
      const m = Array.from({ length: MONTHS }, () => spec.monthlyCents);
      return done(m, `${money(spec.monthlyCents)} a month × 12 = ${money(spec.monthlyCents * 12)}`);
    }
    case 'ANNUAL_EVEN': {
      const m = spreadEven(spec.annualCents);
      return done(m, `${money(spec.annualCents)} spread evenly across 12 months`);
    }
    case 'ANNUAL_SEASONAL': {
      const { months, fellBackToEven } = spreadByShape(spec.annualCents, ctx.pyMonths);
      return done(
        months,
        fellBackToEven
          ? `${money(spec.annualCents)} spread evenly (last year has no usable monthly shape)`
          : `${money(spec.annualCents)} spread by last year’s monthly shape`,
        fellBackToEven,
      );
    }
    case 'PY_GROWTH': {
      const py = months12(ctx.pyMonths);
      const m = growSeries(py, spec.growthBps);
      return done(m, `Last year ${money(sum(py))} ${spec.growthBps >= 0 ? '+' : '−'} ${pctText(Math.abs(spec.growthBps))} = ${money(sum(m))}, last year’s monthly shape`);
    }
    case 'PRIOR_BUDGET_GROWTH': {
      const pb = months12(ctx.priorBudgetMonths);
      const m = growSeries(pb, spec.growthBps);
      return done(m, `Last year’s budget ${money(sum(pb))} ${spec.growthBps >= 0 ? '+' : '−'} ${pctText(Math.abs(spec.growthBps))} = ${money(sum(m))}`);
    }
    case 'PCT_OF_REVENUE': {
      if (!Number.isInteger(spec.pctBps) || spec.pctBps < 0) throw new GeneratorError('Percent of revenue must be whole, non-negative basis points');
      const rev = months12(ctx.revenueMonths);
      const factor = spec.pctBps / 10000;
      const target = roundCents(sum(rev) * factor);
      const m = roundPreservingSum(rev.map((v) => v * factor), target);
      return done(m, `${pctText(spec.pctBps)} of budgeted revenue ${money(sum(rev))} = ${money(sum(m))}`);
    }
    case 'HEADCOUNT_RATE': {
      const { headcount, monthlyRateCents, burdenBps, startMonth } = spec;
      if (!(headcount >= 0) || !Number.isFinite(headcount)) throw new GeneratorError('Headcount must be zero or more');
      assertInt(monthlyRateCents, 'Monthly rate');
      if (!Number.isInteger(burdenBps) || burdenBps < 0) throw new GeneratorError('Burden must be whole, non-negative basis points');
      if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) throw new GeneratorError('Start month must be 1–12');
      const perMonth = headcount * monthlyRateCents * (1 + burdenBps / 10000);
      const raw = Array.from({ length: MONTHS }, (_, i) => (i + 1 >= startMonth ? perMonth : 0));
      const m = roundPreservingSum(raw, roundCents(sum(raw)));
      const active = MONTHS - startMonth + 1;
      return done(
        m,
        `${headcount} × ${money(monthlyRateCents)} a month${burdenBps ? ` + ${pctText(burdenBps)} burden` : ''} × ${active} month${active === 1 ? '' : 's'} = ${money(sum(m))}`,
      );
    }
    case 'UNITS_RATE': {
      const { unitsPerMonth, rateCents, growthBps } = spec;
      if (!(unitsPerMonth >= 0) || !Number.isFinite(unitsPerMonth)) throw new GeneratorError('Units must be zero or more');
      assertInt(rateCents, 'Rate');
      if (!Number.isInteger(growthBps)) throw new GeneratorError('Growth must be whole basis points');
      // Units grow linearly through the year to (1 + growth) × the starting rate by month 12.
      const raw = Array.from({ length: MONTHS }, (_, i) => unitsPerMonth * (1 + (growthBps / 10000) * (i / (MONTHS - 1))) * rateCents);
      const m = roundPreservingSum(raw, roundCents(sum(raw)));
      return done(m, `${unitsPerMonth} units a month × ${money(rateCents)}${growthBps ? `, growing ${pctText(growthBps)} by year end` : ''} = ${money(sum(m))}`);
    }
    case 'MANUAL':
      return done(zeros(), 'Entered by hand');
    default: {
      const never: never = spec;
      throw new GeneratorError(`Unknown driver ${(never as { method: string }).method}`);
    }
  }
}

/** Build a DriverSpec from a stored (method, params) pair, with defaults for missing params. */
export function specFrom(method: DriverMethod, params: Readonly<Record<string, number | undefined>>): DriverSpec {
  const n = (k: string, d = 0): number => {
    const v = params[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : d;
  };
  const i = (k: string, d = 0): number => Math.round(n(k, d));
  switch (method) {
    case 'FIXED_MONTHLY': return { method, monthlyCents: i('monthlyCents') };
    case 'ANNUAL_EVEN': return { method, annualCents: i('annualCents') };
    case 'ANNUAL_SEASONAL': return { method, annualCents: i('annualCents') };
    case 'PY_GROWTH': return { method, growthBps: i('growthBps') };
    case 'PRIOR_BUDGET_GROWTH': return { method, growthBps: i('growthBps') };
    case 'PCT_OF_REVENUE': return { method, pctBps: i('pctBps') };
    case 'HEADCOUNT_RATE':
      return { method, headcount: n('headcount'), monthlyRateCents: i('monthlyRateCents'), burdenBps: i('burdenBps'), startMonth: Math.min(12, Math.max(1, i('startMonth', 1))) };
    case 'UNITS_RATE': return { method, unitsPerMonth: n('unitsPerMonth'), rateCents: i('rateCents'), growthBps: i('growthBps') };
    case 'MANUAL': return { method };
  }
}

/** The params object stored in budget_line_drivers.params for a spec. */
export function paramsOf(spec: DriverSpec): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(spec)) if (k !== 'method' && typeof v === 'number') out[k] = v;
  return out;
}

/** Apply a growth % to an existing 12-month row (the grid's "+x%" action); ties by construction. */
export function applyGrowthToRow(months: readonly number[], growthBps: number): number[] {
  return growSeries(months, growthBps);
}

/**
 * Reforecast (latest estimate): actuals for the closed months, the budget for the rest.
 * `closedThrough` = number of closed periods (0..12).
 */
export function latestEstimate(budget: readonly number[], actual: readonly number[], closedThrough: number): number[] {
  const b = months12(budget);
  const a = months12(actual);
  const k = Math.max(0, Math.min(MONTHS, Math.floor(closedThrough)));
  return b.map((v, i) => (i < k ? a[i] : v));
}
