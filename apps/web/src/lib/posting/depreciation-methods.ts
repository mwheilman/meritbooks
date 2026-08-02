/**
 * Depreciation methods — PURE math, no DB, no side effects.
 *
 * Every function returns a per-period schedule of integer cents whose cumulative
 * total is bounded by the depreciable base (cost − salvage) and, for the
 * life-bounded methods (SL / declining-balance / SYD), lands EXACTLY on the base
 * by the final period (the last non-zero period absorbs all rounding). Nothing
 * here ever produces a fractional cent or overshoots salvage.
 *
 * These are the building blocks the DB-driven engine (`depreciation-engine.ts`)
 * and the UI schedule preview consume. Keeping them pure makes each method unit-
 * testable in isolation — the model is NEVER involved in this arithmetic.
 *
 * Methods:
 *   STRAIGHT_LINE        — equal charge each month.
 *   DECLINING_BALANCE    — `factor`/life applied to opening book value, with the
 *                          standard switch to straight-line on the remaining base
 *                          once SL yields more, so it fully lands on salvage.
 *                          factor 2.0 = 200% (double) DB; 1.5 = 150% DB.
 *   SUM_OF_YEARS_DIGITS  — monthly SYD (accelerated, front-loaded).
 *   UNITS_OF_PRODUCTION  — usage-based; each period charges base × units/total.
 */

export type DepreciationCalcMethod =
  | 'STRAIGHT_LINE'
  | 'DECLINING_BALANCE'
  | 'SUM_OF_YEARS_DIGITS'
  | 'UNITS_OF_PRODUCTION';

/** Thrown on invalid schedule inputs — the engine refuses to guess. */
export class DepreciationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DepreciationInputError';
  }
}

export interface DepreciationScheduleParams {
  costCents: number;
  salvageCents: number;
  /** Life in months; required for SL / DECLINING_BALANCE / SYD. */
  usefulLifeMonths: number;
  method: DepreciationCalcMethod;
  /** Declining-balance factor (2.0 = DDB, 1.5 = 150% DB). Required for DECLINING_BALANCE. */
  decliningFactor?: number;
  /** Total expected lifetime production units. Required for UNITS_OF_PRODUCTION. */
  totalExpectedUnits?: number;
  /** Units produced per period. Required for UNITS_OF_PRODUCTION (defines period count). */
  unitsPerPeriod?: number[];
}

function assertFinancialInputs(costCents: number, salvageCents: number): number {
  if (!Number.isInteger(costCents) || !Number.isInteger(salvageCents)) {
    throw new DepreciationInputError('cost and salvage must be integer cents');
  }
  if (costCents < 0 || salvageCents < 0) {
    throw new DepreciationInputError('cost and salvage must be non-negative');
  }
  const base = costCents - salvageCents;
  if (base <= 0) {
    throw new DepreciationInputError('no depreciable base (cost must exceed salvage)');
  }
  return base;
}

/** Equal monthly charge; the final month absorbs the rounding remainder. */
export function straightLineSchedule(costCents: number, salvageCents: number, usefulLifeMonths: number): number[] {
  const base = assertFinancialInputs(costCents, salvageCents);
  if (!Number.isInteger(usefulLifeMonths) || usefulLifeMonths <= 0) {
    throw new DepreciationInputError('usefulLifeMonths must be a positive integer');
  }
  const monthly = Math.floor(base / usefulLifeMonths);
  const schedule: number[] = [];
  let accumulated = 0;
  for (let m = 0; m < usefulLifeMonths; m++) {
    const isLast = m === usefulLifeMonths - 1;
    const amount = isLast ? base - accumulated : monthly;
    schedule.push(amount);
    accumulated += amount;
  }
  return schedule;
}

/**
 * Declining-balance with straight-line switchover. `factor`/life is applied to
 * the opening book value each month; once straight-line over the remaining life
 * on the remaining depreciable base yields a larger charge, the method switches
 * (the textbook convention that guarantees the asset reaches salvage exactly).
 * Never depreciates below salvage; the last period lands on the base.
 */
export function decliningBalanceSchedule(
  costCents: number,
  salvageCents: number,
  usefulLifeMonths: number,
  factor: number
): number[] {
  const base = assertFinancialInputs(costCents, salvageCents);
  if (!Number.isInteger(usefulLifeMonths) || usefulLifeMonths <= 0) {
    throw new DepreciationInputError('usefulLifeMonths must be a positive integer');
  }
  if (!(factor > 0)) {
    throw new DepreciationInputError('declining-balance factor must be positive');
  }
  const rate = factor / usefulLifeMonths;
  const schedule: number[] = [];
  let bookValue = costCents; // depreciate the whole cost down toward salvage
  let accumulated = 0;
  for (let m = 0; m < usefulLifeMonths; m++) {
    const remainingBase = base - accumulated; // room left before hitting salvage
    if (remainingBase <= 0) {
      schedule.push(0);
      continue;
    }
    const remainingMonths = usefulLifeMonths - m;
    const isLast = remainingMonths === 1;
    if (isLast) {
      schedule.push(remainingBase);
      accumulated += remainingBase;
      bookValue -= remainingBase;
      continue;
    }
    const dbAmount = Math.round(rate * bookValue);
    const slAmount = Math.floor(remainingBase / remainingMonths);
    let amount = Math.max(dbAmount, slAmount); // switch to SL when it charges more
    if (amount > remainingBase) amount = remainingBase; // never below salvage
    if (amount < 0) amount = 0;
    schedule.push(amount);
    accumulated += amount;
    bookValue -= amount;
  }
  return schedule;
}

/** Monthly sum-of-years'-digits (accelerated). Final period absorbs remainder. */
export function sumOfYearsDigitsSchedule(costCents: number, salvageCents: number, usefulLifeMonths: number): number[] {
  const base = assertFinancialInputs(costCents, salvageCents);
  if (!Number.isInteger(usefulLifeMonths) || usefulLifeMonths <= 0) {
    throw new DepreciationInputError('usefulLifeMonths must be a positive integer');
  }
  const n = usefulLifeMonths;
  const digitsSum = (n * (n + 1)) / 2;
  const schedule: number[] = [];
  let accumulated = 0;
  for (let i = 1; i <= n; i++) {
    const isLast = i === n;
    const raw = Math.round((base * (n - i + 1)) / digitsSum);
    let amount = isLast ? base - accumulated : Math.min(raw, base - accumulated);
    if (amount < 0) amount = 0;
    schedule.push(amount);
    accumulated += amount;
  }
  return schedule;
}

/**
 * Units-of-production. Each period charges base × unitsThisPeriod / totalUnits,
 * capped at the remaining base. Unlike the time-based methods this does NOT
 * force a full write-down — the asset only depreciates as it is used.
 */
export function unitsOfProductionSchedule(
  costCents: number,
  salvageCents: number,
  totalExpectedUnits: number,
  unitsPerPeriod: number[]
): number[] {
  const base = assertFinancialInputs(costCents, salvageCents);
  if (!(totalExpectedUnits > 0)) {
    throw new DepreciationInputError('totalExpectedUnits must be positive');
  }
  if (!Array.isArray(unitsPerPeriod) || unitsPerPeriod.length === 0) {
    throw new DepreciationInputError('unitsPerPeriod must be a non-empty array');
  }
  const schedule: number[] = [];
  let accumulated = 0;
  for (const units of unitsPerPeriod) {
    if (units < 0) throw new DepreciationInputError('period units must be non-negative');
    const remainingBase = base - accumulated;
    if (remainingBase <= 0) {
      schedule.push(0);
      continue;
    }
    const raw = Math.round((base * units) / totalExpectedUnits);
    const amount = Math.min(raw, remainingBase);
    schedule.push(amount);
    accumulated += amount;
  }
  return schedule;
}

/** Dispatch to the right method and return the per-period cents schedule. */
export function buildDepreciationSchedule(params: DepreciationScheduleParams): number[] {
  switch (params.method) {
    case 'STRAIGHT_LINE':
      return straightLineSchedule(params.costCents, params.salvageCents, params.usefulLifeMonths);
    case 'DECLINING_BALANCE':
      if (params.decliningFactor == null) {
        throw new DepreciationInputError('DECLINING_BALANCE requires decliningFactor');
      }
      return decliningBalanceSchedule(
        params.costCents,
        params.salvageCents,
        params.usefulLifeMonths,
        params.decliningFactor
      );
    case 'SUM_OF_YEARS_DIGITS':
      return sumOfYearsDigitsSchedule(params.costCents, params.salvageCents, params.usefulLifeMonths);
    case 'UNITS_OF_PRODUCTION':
      if (params.totalExpectedUnits == null || params.unitsPerPeriod == null) {
        throw new DepreciationInputError('UNITS_OF_PRODUCTION requires totalExpectedUnits and unitsPerPeriod');
      }
      return unitsOfProductionSchedule(
        params.costCents,
        params.salvageCents,
        params.totalExpectedUnits,
        params.unitsPerPeriod
      );
    default: {
      const _never: never = params.method;
      throw new DepreciationInputError(`unknown depreciation method ${String(_never)}`);
    }
  }
}

/** Cumulative depreciation through (and including) period index `throughIdx` (0-based). */
export function cumulativeThrough(schedule: number[], throughIdx: number): number {
  let sum = 0;
  for (let i = 0; i <= throughIdx && i < schedule.length; i++) sum += schedule[i];
  return sum;
}

/**
 * Map the stored `depreciation_method_enum` value to a pure, LIFE-BASED calc method
 * for the BOOK ledger (STRAIGHT_LINE, 200%/150% declining balance, sum-of-years-
 * digits). Returns null for:
 *   - UNITS_OF_PRODUCTION — usage-based, driven off the units meter, not a time
 *     schedule; the engine/preview handle it via `unitsProductionTarget` instead.
 *   - MACRS_* — the parallel TAX track (tax-depreciation.ts), never the book GL.
 * Null means "not a life-based book schedule", not "unsupported" — callers branch.
 */
export function mapBookMethod(
  enumValue: string
): { method: DepreciationCalcMethod; decliningFactor?: number } | null {
  switch (enumValue) {
    case 'STRAIGHT_LINE':
      return { method: 'STRAIGHT_LINE' };
    case 'DOUBLE_DECLINING':
      return { method: 'DECLINING_BALANCE', decliningFactor: 2.0 };
    case 'DECLINING_150':
      return { method: 'DECLINING_BALANCE', decliningFactor: 1.5 };
    case 'SUM_OF_YEARS_DIGITS':
      return { method: 'SUM_OF_YEARS_DIGITS' };
    default:
      return null; // UNITS_OF_PRODUCTION → units path; MACRS_* → tax engine
  }
}

/** True when the stored method is the usage-based units-of-production method. */
export function isUnitsMethod(enumValue: string): boolean {
  return enumValue === 'UNITS_OF_PRODUCTION';
}

/**
 * Cumulative units-of-production depreciation TARGET given usage-to-date. Because
 * units depreciation is `base × units / total`, the correct accumulated balance at
 * any point is a pure function of cumulative units used — so the poster charges
 * (target − already-accumulated) each period. Capped at the depreciable base;
 * never overshoots salvage. Reuses the tested `unitsOfProductionSchedule`.
 */
export function unitsProductionTarget(
  costCents: number,
  salvageCents: number,
  totalExpectedUnits: number,
  cumulativeUnitsUsed: number
): number {
  const [target] = unitsOfProductionSchedule(costCents, salvageCents, totalExpectedUnits, [cumulativeUnitsUsed]);
  return target;
}
