/**
 * FP&A scenario / what-if modeling — pure, deterministic override engine.
 *
 * No I/O. Sits ON TOP of the driver-based budget engine (`lib/budget/drivers`):
 * a scenario is a NAMED SET OF OVERRIDES applied to an existing driver model
 * (the plan-of-record assumptions). We transform the DRIVERS (not the expanded
 * numbers) and then re-run the exact same `expandDrivers` expansion — so every
 * downstream dependency flows naturally (e.g. a `percent_of_revenue` cost driver
 * automatically re-bases when a revenue-growth override scales the revenue
 * drivers). This is the single source of truth the API route and the UI both
 * call; it must never fork the driver math.
 *
 * Three-case discipline: a scenario carries an explicit override list for each
 * of BEST / BASE / WORST (direction is author-owned — headcount UP is a cost, so
 * the model does not guess sign). Each case = baseDrivers + that case's overrides
 * → expand → summarize (revenue, gross margin, net income, ending cash).
 *
 * Cash proxy: ending cash = beginning cash + cumulative net income. This is the
 * standard net-income-to-cash simplification for a driver what-if (it ignores
 * working-capital timing and non-cash items); the real direct cash-flow forecast
 * lives elsewhere. It is deliberately simple and deterministic so a scenario is
 * fully reproducible from its stored payload.
 *
 * Money is bigint cents throughout — never floating point. Overrides carry
 * fractional assumptions (a % in basis points, a per-head cost in cents); the
 * derived cents are always integers (Math.round at the expansion boundary).
 */

import {
  expandDrivers,
  BPS_DENOMINATOR,
  MONTHS_IN_YEAR,
  type BudgetDriver,
  type DriverExpansionResult,
  type AccountType,
} from './drivers';

// ─────────────────────────────────────────────────────────────────────────────
// Override model
// ─────────────────────────────────────────────────────────────────────────────

/** Income-statement account types that behave as COST lines (expense-like). */
export const COST_TYPES: AccountType[] = ['COGS', 'OPEX'];

/**
 * A single what-if lever applied to the base driver set.
 *  - `revenue_growth`: scale every REVENUE driver by (1 + deltaBps/10000).
 *  - `cost_change`:    scale cost drivers (default COGS+OPEX) by (1 + deltaBps/10000).
 *  - `headcount`:      add/remove N heads → append a fixed OPEX driver of
 *                      deltaHeads × monthlyCostPerHeadCents × 12 (negative heads
 *                      reduce cost). Direction is author-owned.
 */
export type ScenarioOverride =
  | { kind: 'revenue_growth'; deltaBps: number }
  | { kind: 'cost_change'; deltaBps: number; costTypes?: AccountType[] }
  | {
      kind: 'headcount';
      deltaHeads: number;
      monthlyCostPerHeadCents: number;
      accountId: string;
    };

/** The three author-owned case override lists. */
export interface ScenarioCases {
  best: ScenarioOverride[];
  base: ScenarioOverride[];
  worst: ScenarioOverride[];
}

/** A fully self-contained, reproducible scenario definition (what we persist). */
export interface ScenarioDefinition {
  name: string;
  /** The underlying driver assumptions the overrides are applied to. */
  baseDrivers: BudgetDriver[];
  cases: ScenarioCases;
  /** Opening cash for the ending-cash proxy (cents). */
  beginningCashCents: number;
}

const HEADCOUNT_SENTINEL_ACCOUNT = '__headcount__';

// ─────────────────────────────────────────────────────────────────────────────
// Override application (driver → driver, then re-expand)
// ─────────────────────────────────────────────────────────────────────────────

/** Scale a single driver's magnitude by `factor` (keeps its shape/dependencies). */
function scaleDriver(d: BudgetDriver, factor: number): BudgetDriver {
  switch (d.driverType) {
    case 'volume_x_rate':
      // Scale volume (units may be fractional; expansion rounds the cents).
      return { ...d, volumeByMonth: d.volumeByMonth.map((v) => v * factor) };
    case 'fixed':
      return { ...d, annualAmountCents: Math.round(d.annualAmountCents * factor) };
    case 'growth_rate':
      return { ...d, baseMonthlyCents: Math.round(d.baseMonthlyCents * factor) };
    case 'percent_of_revenue':
      // A ratio driver: scaling the ratio changes the margin on top of any
      // revenue re-basing that already happens via the revenue base.
      return { ...d, percentBps: Math.round(d.percentBps * factor) };
  }
}

/** Apply one override, returning a NEW driver array (never mutates input). */
export function applyOverride(
  drivers: BudgetDriver[],
  override: ScenarioOverride
): BudgetDriver[] {
  switch (override.kind) {
    case 'revenue_growth': {
      const factor = 1 + override.deltaBps / BPS_DENOMINATOR;
      return drivers.map((d) =>
        d.accountType === 'REVENUE' ? scaleDriver(d, factor) : d
      );
    }
    case 'cost_change': {
      const factor = 1 + override.deltaBps / BPS_DENOMINATOR;
      const types = override.costTypes ?? COST_TYPES;
      return drivers.map((d) =>
        types.includes(d.accountType) ? scaleDriver(d, factor) : d
      );
    }
    case 'headcount': {
      if (override.deltaHeads === 0) return drivers;
      const annual =
        override.deltaHeads * override.monthlyCostPerHeadCents * MONTHS_IN_YEAR;
      const added: BudgetDriver = {
        id: `__hc_${override.deltaHeads}_${override.monthlyCostPerHeadCents}`,
        label: `Headcount ${override.deltaHeads > 0 ? '+' : ''}${override.deltaHeads}`,
        accountId: override.accountId || HEADCOUNT_SENTINEL_ACCOUNT,
        accountType: 'OPEX',
        driverType: 'fixed',
        annualAmountCents: Math.round(annual),
      };
      return [...drivers, added];
    }
  }
}

/** Apply an ordered override list, folding left. Pure. */
export function applyOverrides(
  drivers: BudgetDriver[],
  overrides: ScenarioOverride[]
): BudgetDriver[] {
  return overrides.reduce(applyOverride, drivers);
}

// ─────────────────────────────────────────────────────────────────────────────
// Summaries
// ─────────────────────────────────────────────────────────────────────────────

export interface ScenarioSummary {
  revenueCents: number;
  cogsCents: number;
  grossProfitCents: number;
  /** Gross profit ÷ revenue, in basis points (0 when no revenue). */
  grossMarginBps: number;
  opexCents: number;
  otherCents: number;
  /** revenue − COGS − OPEX. */
  operatingIncomeCents: number;
  /** operating income − OTHER (OTHER treated conservatively as expense-like). */
  netIncomeCents: number;
  /** Net income ÷ revenue, in basis points (0 when no revenue). */
  netMarginBps: number;
  beginningCashCents: number;
  /** beginning cash + full-year net income (net-income-to-cash proxy). */
  endingCashCents: number;
  revenueByMonth: number[]; // length 12
  netIncomeByMonth: number[]; // length 12
  endingCashByMonth: number[]; // length 12, running balance
}

function zero12(): number[] {
  return new Array<number>(MONTHS_IN_YEAR).fill(0);
}

function marginBps(numer: number, denom: number): number {
  if (denom === 0) return 0;
  return Math.round((numer / Math.abs(denom)) * BPS_DENOMINATOR);
}

/**
 * Reduce a driver expansion into a P&L + cash summary. Totals are derived from
 * the expanded per-account lines (so a percent-of-revenue REVENUE line is
 * counted consistently with cost lines), not from the driver definitions.
 */
export function summarizeExpansion(
  expansion: DriverExpansionResult,
  beginningCashCents: number
): ScenarioSummary {
  const byType: Record<AccountType, number[]> = {
    REVENUE: zero12(),
    COGS: zero12(),
    OPEX: zero12(),
    OTHER: zero12(),
  };
  for (const line of expansion.lines) {
    const bucket = byType[line.accountType];
    for (let m = 0; m < MONTHS_IN_YEAR; m++) bucket[m] += line.monthlyCents[m];
  }

  const revenueByMonth = byType.REVENUE;
  const netIncomeByMonth = zero12();
  const endingCashByMonth = zero12();
  let running = beginningCashCents;
  for (let m = 0; m < MONTHS_IN_YEAR; m++) {
    const ni =
      byType.REVENUE[m] - byType.COGS[m] - byType.OPEX[m] - byType.OTHER[m];
    netIncomeByMonth[m] = ni;
    running += ni;
    endingCashByMonth[m] = running;
  }

  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const revenueCents = sum(byType.REVENUE);
  const cogsCents = sum(byType.COGS);
  const opexCents = sum(byType.OPEX);
  const otherCents = sum(byType.OTHER);
  const grossProfitCents = revenueCents - cogsCents;
  const operatingIncomeCents = grossProfitCents - opexCents;
  const netIncomeCents = operatingIncomeCents - otherCents;

  return {
    revenueCents,
    cogsCents,
    grossProfitCents,
    grossMarginBps: marginBps(grossProfitCents, revenueCents),
    opexCents,
    otherCents,
    operatingIncomeCents,
    netIncomeCents,
    netMarginBps: marginBps(netIncomeCents, revenueCents),
    beginningCashCents,
    endingCashCents: beginningCashCents + netIncomeCents,
    revenueByMonth,
    netIncomeByMonth,
    endingCashByMonth,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Case + three-case build
// ─────────────────────────────────────────────────────────────────────────────

export interface ScenarioCaseResult {
  overrides: ScenarioOverride[];
  expansion: DriverExpansionResult;
  summary: ScenarioSummary;
}

/** Apply a case's overrides, expand, and summarize. Pure + deterministic. */
export function buildScenarioCase(
  baseDrivers: BudgetDriver[],
  overrides: ScenarioOverride[],
  beginningCashCents: number
): ScenarioCaseResult {
  const drivers = applyOverrides(baseDrivers, overrides);
  const expansion = expandDrivers(drivers);
  const summary = summarizeExpansion(expansion, beginningCashCents);
  return { overrides, expansion, summary };
}

/** Difference of headline metrics: case − base. */
export interface ScenarioVariance {
  revenueCents: number;
  grossProfitCents: number;
  grossMarginBps: number;
  netIncomeCents: number;
  endingCashCents: number;
}

function varianceOf(
  caseSummary: ScenarioSummary,
  base: ScenarioSummary
): ScenarioVariance {
  return {
    revenueCents: caseSummary.revenueCents - base.revenueCents,
    grossProfitCents: caseSummary.grossProfitCents - base.grossProfitCents,
    grossMarginBps: caseSummary.grossMarginBps - base.grossMarginBps,
    netIncomeCents: caseSummary.netIncomeCents - base.netIncomeCents,
    endingCashCents: caseSummary.endingCashCents - base.endingCashCents,
  };
}

export interface ThreeCaseResult {
  best: ScenarioCaseResult;
  base: ScenarioCaseResult;
  worst: ScenarioCaseResult;
  varianceVsBase: { best: ScenarioVariance; worst: ScenarioVariance };
}

/** Build BEST / BASE / WORST from one scenario definition. Pure. */
export function buildThreeCase(def: ScenarioDefinition): ThreeCaseResult {
  const best = buildScenarioCase(def.baseDrivers, def.cases.best, def.beginningCashCents);
  const base = buildScenarioCase(def.baseDrivers, def.cases.base, def.beginningCashCents);
  const worst = buildScenarioCase(def.baseDrivers, def.cases.worst, def.beginningCashCents);
  return {
    best,
    base,
    worst,
    varianceVsBase: {
      best: varianceOf(best.summary, base.summary),
      worst: varianceOf(worst.summary, base.summary),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// One-driver sensitivity (tornado sweep)
// ─────────────────────────────────────────────────────────────────────────────

export type SensitivityAxis = 'revenue_growth' | 'cost_change' | 'headcount';

export interface SensitivitySpec {
  axis: SensitivityAxis;
  /**
   * Scalar values to sweep along the axis:
   *  - revenue_growth / cost_change → basis points (e.g. -2000..2000).
   *  - headcount → head count delta (e.g. -5..5).
   */
  points: number[];
  /** Base-case overrides applied under every swept point (default none). */
  baseOverrides?: ScenarioOverride[];
  // headcount axis inputs:
  monthlyCostPerHeadCents?: number;
  accountId?: string;
  // cost_change axis input:
  costTypes?: AccountType[];
}

function overrideForAxis(spec: SensitivitySpec, value: number): ScenarioOverride {
  switch (spec.axis) {
    case 'revenue_growth':
      return { kind: 'revenue_growth', deltaBps: value };
    case 'cost_change':
      return { kind: 'cost_change', deltaBps: value, costTypes: spec.costTypes };
    case 'headcount':
      return {
        kind: 'headcount',
        deltaHeads: value,
        monthlyCostPerHeadCents: spec.monthlyCostPerHeadCents ?? 0,
        accountId: spec.accountId ?? HEADCOUNT_SENTINEL_ACCOUNT,
      };
  }
}

export interface SensitivityPoint {
  value: number;
  revenueCents: number;
  grossMarginBps: number;
  netIncomeCents: number;
  endingCashCents: number;
}

export interface SensitivityResult {
  axis: SensitivityAxis;
  points: SensitivityPoint[];
}

/**
 * Sweep ONE lever across a range, holding everything else fixed, and report the
 * resulting revenue / gross margin / net income / ending cash at each step. The
 * classic one-way "what moves the model most" analysis.
 */
export function runSensitivity(
  baseDrivers: BudgetDriver[],
  spec: SensitivitySpec,
  beginningCashCents: number
): SensitivityResult {
  const baseOverrides = spec.baseOverrides ?? [];
  const points = spec.points.map((value) => {
    const overrides = [...baseOverrides, overrideForAxis(spec, value)];
    const { summary } = buildScenarioCase(baseDrivers, overrides, beginningCashCents);
    return {
      value,
      revenueCents: summary.revenueCents,
      grossMarginBps: summary.grossMarginBps,
      netIncomeCents: summary.netIncomeCents,
      endingCashCents: summary.endingCashCents,
    };
  });
  return { axis: spec.axis, points };
}
