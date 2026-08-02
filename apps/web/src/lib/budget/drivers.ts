/**
 * Driver-based budgeting — pure expansion engine.
 *
 * No I/O. Given a set of *driver definitions* (a human-owned model of HOW a
 * budget line is built — units × price, a cost as % of revenue, a fixed amount,
 * a compounding growth curve) this expands them deterministically into monthly
 * budget lines (12 periods) per GL account. The AI layer may PROPOSE the driver
 * assumptions (rates, growth %) for a human to edit — it never invents the
 * resulting numbers; this engine does that math, and it is the single source of
 * truth the API route and the UI preview both call.
 *
 * Money is bigint cents throughout — never floating point (CANON-ANCHOR §2).
 * A driver's rate / percent / growth is an assumption the human owns; the
 * derived cents are always integers (Math.round at the boundary).
 *
 * Ordering / dependency rule (kept acyclic on purpose): a `percent_of_revenue`
 * driver is computed against the *revenue base* — the summed monthly output of
 * every NON-percent driver whose account type is REVENUE. A percent-of-revenue
 * driver therefore cannot itself feed the revenue base (no circular models).
 */

export const MONTHS_IN_YEAR = 12;
export const BPS_DENOMINATOR = 10_000; // basis points → fraction

/** Income-statement account types (CANON-ANCHOR §2 — there is NO `EXPENSE`). */
export type AccountType = 'REVENUE' | 'COGS' | 'OPEX' | 'OTHER';

export type DriverType =
  | 'volume_x_rate'
  | 'percent_of_revenue'
  | 'fixed'
  | 'growth_rate';

interface DriverBase {
  /** Stable client id for the row (also the preview/expansion key). */
  id: string;
  label: string;
  /** GL account this driver's output posts to (a budget cell target). */
  accountId: string;
  accountType: AccountType;
  driverType: DriverType;
}

/** Volume × rate: monthlyCents[m] = round(volumeByMonth[m] × unitRateCents). */
export interface VolumeRateDriver extends DriverBase {
  driverType: 'volume_x_rate';
  /** Cents per unit (an assumption the human owns). */
  unitRateCents: number;
  /** Units per month, length 12. Shorter arrays are zero-padded. */
  volumeByMonth: number[];
}

/** A cost/line expressed as a % (basis points) of the revenue base per month. */
export interface PercentOfRevenueDriver extends DriverBase {
  driverType: 'percent_of_revenue';
  /** Basis points: 2500 = 25.00%. */
  percentBps: number;
}

/** A fixed annual amount spread across 12 months (even, or by relative weights). */
export interface FixedDriver extends DriverBase {
  driverType: 'fixed';
  annualAmountCents: number;
  /** Optional length-12 relative weights (seasonality). Omit ⇒ even 1/12. */
  weights?: number[];
}

/** Compounding growth from a starting monthly amount at a monthly rate. */
export interface GrowthRateDriver extends DriverBase {
  driverType: 'growth_rate';
  /** Month-1 (January) amount in cents. */
  baseMonthlyCents: number;
  /** Basis points of month-over-month growth: 200 = 2.00%/mo (may be negative). */
  monthlyGrowthBps: number;
}

export type BudgetDriver =
  | VolumeRateDriver
  | PercentOfRevenueDriver
  | FixedDriver
  | GrowthRateDriver;

/** One driver expanded to its 12 monthly amounts. */
export interface DriverExpansion {
  driverId: string;
  label: string;
  accountId: string;
  accountType: AccountType;
  driverType: DriverType;
  monthlyCents: number[]; // length 12
  annualCents: number;
}

/** Multiple drivers targeting the same account, summed into one budget line. */
export interface ExpandedAccountLine {
  accountId: string;
  accountType: AccountType;
  monthlyCents: number[]; // length 12
  annualCents: number;
}

export interface DriverExpansionResult {
  drivers: DriverExpansion[];
  lines: ExpandedAccountLine[];
  /** The revenue base each percent-of-revenue driver is applied against. */
  revenueByMonth: number[]; // length 12
  totalRevenueCents: number;
}

/** A fresh array of 12 zeros. */
function zeroMonths(): number[] {
  return new Array<number>(MONTHS_IN_YEAR).fill(0);
}

function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}

/**
 * Spread an annual amount into 12 integer-cent months, guaranteeing the months
 * sum EXACTLY to `annualCents`. With no weights the remainder lands in January
 * (matches the existing even-spread behavior in the budget entry grid); with
 * weights, per-month rounding drift is absorbed in December.
 */
export function spreadAnnual(annualCents: number, weights?: number[]): number[] {
  const w = weights && weights.length === MONTHS_IN_YEAR ? weights : null;
  const totalW = w ? sum(w) : 0;

  if (!w || totalW <= 0) {
    // Even 1/12 with the remainder in January.
    const base = Math.trunc(annualCents / MONTHS_IN_YEAR);
    const remainder = annualCents - base * MONTHS_IN_YEAR;
    const out = new Array<number>(MONTHS_IN_YEAR).fill(base);
    out[0] += remainder;
    return out;
  }

  const out = zeroMonths();
  let allocated = 0;
  for (let m = 0; m < MONTHS_IN_YEAR; m++) {
    const share = Math.round((annualCents * w[m]) / totalW);
    out[m] = share;
    allocated += share;
  }
  // Absorb rounding drift so the sum ties exactly to the annual amount.
  out[MONTHS_IN_YEAR - 1] += annualCents - allocated;
  return out;
}

/** Expand a single non-percent driver. Percent drivers are handled in a 2nd pass. */
function expandBaseDriver(
  driver: Exclude<BudgetDriver, PercentOfRevenueDriver>
): number[] {
  switch (driver.driverType) {
    case 'volume_x_rate': {
      const out = zeroMonths();
      for (let m = 0; m < MONTHS_IN_YEAR; m++) {
        const units = driver.volumeByMonth[m] ?? 0;
        out[m] = Math.round(units * driver.unitRateCents);
      }
      return out;
    }
    case 'fixed':
      return spreadAnnual(driver.annualAmountCents, driver.weights);
    case 'growth_rate': {
      const out = zeroMonths();
      const g = driver.monthlyGrowthBps / BPS_DENOMINATOR;
      let prev = driver.baseMonthlyCents;
      out[0] = Math.round(prev);
      for (let m = 1; m < MONTHS_IN_YEAR; m++) {
        prev = prev * (1 + g);
        out[m] = Math.round(prev);
      }
      return out;
    }
  }
}

/**
 * Expand a driver model into monthly budget lines. Deterministic and pure.
 *
 * Two passes: (1) every non-percent driver, accumulating the REVENUE base;
 * (2) every percent-of-revenue driver applied to that base. Drivers that target
 * the same account are summed into one `ExpandedAccountLine`.
 */
export function expandDrivers(drivers: BudgetDriver[]): DriverExpansionResult {
  const expansions: DriverExpansion[] = [];
  const revenueByMonth = zeroMonths();

  // Pass 1 — non-percent drivers; build the revenue base as we go.
  for (const driver of drivers) {
    if (driver.driverType === 'percent_of_revenue') continue;
    const monthlyCents = expandBaseDriver(driver);
    if (driver.accountType === 'REVENUE') {
      for (let m = 0; m < MONTHS_IN_YEAR; m++) revenueByMonth[m] += monthlyCents[m];
    }
    expansions.push({
      driverId: driver.id,
      label: driver.label,
      accountId: driver.accountId,
      accountType: driver.accountType,
      driverType: driver.driverType,
      monthlyCents,
      annualCents: sum(monthlyCents),
    });
  }

  // Pass 2 — percent-of-revenue drivers against the finalized revenue base.
  for (const driver of drivers) {
    if (driver.driverType !== 'percent_of_revenue') continue;
    const monthlyCents = zeroMonths();
    for (let m = 0; m < MONTHS_IN_YEAR; m++) {
      monthlyCents[m] = Math.round(
        (revenueByMonth[m] * driver.percentBps) / BPS_DENOMINATOR
      );
    }
    expansions.push({
      driverId: driver.id,
      label: driver.label,
      accountId: driver.accountId,
      accountType: driver.accountType,
      driverType: driver.driverType,
      monthlyCents,
      annualCents: sum(monthlyCents),
    });
  }

  // Roll drivers up into one line per account.
  const lineMap = new Map<string, ExpandedAccountLine>();
  for (const e of expansions) {
    const existing = lineMap.get(e.accountId);
    if (existing) {
      for (let m = 0; m < MONTHS_IN_YEAR; m++) existing.monthlyCents[m] += e.monthlyCents[m];
      existing.annualCents += e.annualCents;
    } else {
      lineMap.set(e.accountId, {
        accountId: e.accountId,
        accountType: e.accountType,
        monthlyCents: [...e.monthlyCents],
        annualCents: e.annualCents,
      });
    }
  }

  return {
    drivers: expansions,
    lines: Array.from(lineMap.values()),
    revenueByMonth,
    totalRevenueCents: sum(revenueByMonth),
  };
}

/**
 * Flatten an expansion into the `{ account_id, period_number, amount_cents }`
 * cell rows the existing `budgets` table / `/api/budgets` POST path accepts
 * (period_number is 1-based). One row per account × month (including zeros, so a
 * cleared driver overwrites a previously-saved cell).
 */
export function expansionToBudgetCells(
  result: DriverExpansionResult
): { account_id: string; period_number: number; amount_cents: number }[] {
  const cells: { account_id: string; period_number: number; amount_cents: number }[] = [];
  for (const line of result.lines) {
    for (let m = 0; m < MONTHS_IN_YEAR; m++) {
      cells.push({
        account_id: line.accountId,
        period_number: m + 1,
        amount_cents: line.monthlyCents[m],
      });
    }
  }
  return cells;
}
