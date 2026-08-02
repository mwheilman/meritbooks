/**
 * FP&A Dashboard — pure computation core (Pillar 3: native FP&A).
 *
 * No I/O. Every KPI, variance figure, trend point, and runway number the
 * `/fpna` dashboard renders is computed HERE, deterministically, from
 * already-fetched ledger aggregates. The API route (app/api/fpna/dashboard)
 * does the RLS-scoped Supabase reads — reusing the SAME account-type math the
 * income-statement / balance-sheet / budget-vs-actual routes use (revenue =
 * credits − debits; expense = debits − credits; balances by normal side) — and
 * hands the totals here. Keeping the math pure makes it exhaustively unit
 * testable and guarantees the dashboard can never disagree with the statements.
 *
 * All money is bigint cents — never floating point. Ratios/percentages are the
 * only derived floats and are `null` (not 0, not Infinity) when the base is 0,
 * so the UI can say "n/a" instead of fabricating a number.
 */

export type PnlSection = 'REVENUE' | 'COGS' | 'OPEX' | 'OTHER';

/** Period P&L totals, natural sign, in cents (same convention as the IS route). */
export interface PnlAggregate {
  revenueCents: number;
  cogsCents: number;
  opexCents: number;
  /** Net "Other income / (expense)" presented the way the IS route subtracts it
   *  from EBITDA to reach net income (netIncome = ebitda − other). */
  otherCents: number;
}

/** Balance-sheet snapshot inputs (as-of the period end), in cents. */
export interface BalanceInputs {
  cashCents: number;
  arCents: number;
  apCents: number;
  currentAssetsCents: number;
  currentLiabilitiesCents: number;
}

export interface KpiInputs {
  pnl: PnlAggregate;
  balance: BalanceInputs;
}

export interface Kpis {
  revenueCents: number;
  cogsCents: number;
  grossProfitCents: number;
  grossMarginPct: number | null;
  opexCents: number;
  operatingIncomeCents: number;
  operatingMarginPct: number | null;
  otherCents: number;
  netIncomeCents: number;
  netMarginPct: number | null;
  cashCents: number;
  arCents: number;
  apCents: number;
  currentAssetsCents: number;
  currentLiabilitiesCents: number;
  workingCapitalCents: number;
  /** Current assets ÷ current liabilities; null when there are no current
   *  liabilities (ratio undefined). Two decimals. */
  currentRatio: number | null;
}

// ── rounding helpers ────────────────────────────────────────────────────────

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Margin `part / whole` as a percent; null when whole is 0. */
export function marginPct(partCents: number, wholeCents: number): number | null {
  if (wholeCents === 0) return null;
  return round2((partCents / wholeCents) * 100);
}

// ── KPIs ─────────────────────────────────────────────────────────────────────

/**
 * Compute the full KPI set for ONE period from its P&L + balance-sheet totals.
 * Pure: numbers in → numbers out.
 */
export function computeKpis(input: KpiInputs): Kpis {
  const { pnl, balance } = input;
  const grossProfitCents = pnl.revenueCents - pnl.cogsCents;
  const operatingIncomeCents = grossProfitCents - pnl.opexCents;
  const netIncomeCents = operatingIncomeCents - pnl.otherCents;

  const currentRatio =
    balance.currentLiabilitiesCents === 0
      ? null
      : round2(balance.currentAssetsCents / balance.currentLiabilitiesCents);

  return {
    revenueCents: pnl.revenueCents,
    cogsCents: pnl.cogsCents,
    grossProfitCents,
    grossMarginPct: marginPct(grossProfitCents, pnl.revenueCents),
    opexCents: pnl.opexCents,
    operatingIncomeCents,
    operatingMarginPct: marginPct(operatingIncomeCents, pnl.revenueCents),
    otherCents: pnl.otherCents,
    netIncomeCents,
    netMarginPct: marginPct(netIncomeCents, pnl.revenueCents),
    cashCents: balance.cashCents,
    arCents: balance.arCents,
    apCents: balance.apCents,
    currentAssetsCents: balance.currentAssetsCents,
    currentLiabilitiesCents: balance.currentLiabilitiesCents,
    workingCapitalCents: balance.currentAssetsCents - balance.currentLiabilitiesCents,
    currentRatio,
  };
}

// ── Period-over-period deltas ─────────────────────────────────────────────────

export interface Delta {
  currentCents: number;
  priorCents: number;
  deltaCents: number;
  /** Percent change vs |prior|; null when prior is 0 (not computable). */
  pct: number | null;
}

/** Delta of two raw values (cents OR percentage points), with % change. */
export function computeDelta(current: number, prior: number): Delta {
  return {
    currentCents: current,
    priorCents: prior,
    deltaCents: current - prior,
    pct: prior === 0 ? null : round1(((current - prior) / Math.abs(prior)) * 100),
  };
}

export interface KpiSet {
  current: Kpis;
  prior: Kpis | null;
  /** Deltas keyed by KPI. Present only when a prior period is supplied. */
  deltas: Record<string, Delta>;
}

const DELTA_KEYS: { key: string; pick: (k: Kpis) => number | null }[] = [
  { key: 'revenue', pick: (k) => k.revenueCents },
  { key: 'grossProfit', pick: (k) => k.grossProfitCents },
  { key: 'grossMarginPct', pick: (k) => k.grossMarginPct },
  { key: 'operatingIncome', pick: (k) => k.operatingIncomeCents },
  { key: 'netIncome', pick: (k) => k.netIncomeCents },
  { key: 'netMarginPct', pick: (k) => k.netMarginPct },
  { key: 'cash', pick: (k) => k.cashCents },
  { key: 'ar', pick: (k) => k.arCents },
  { key: 'ap', pick: (k) => k.apCents },
  { key: 'workingCapital', pick: (k) => k.workingCapitalCents },
  { key: 'currentRatio', pick: (k) => k.currentRatio },
];

/**
 * Compute the current period's KPIs, the prior period's KPIs (optional), and the
 * deltas between them. A null on either side of a metric (e.g. a margin with 0
 * revenue) is treated as 0 for the delta so the card can still render a movement.
 */
export function computeKpiSet(current: KpiInputs, prior: KpiInputs | null): KpiSet {
  const cur = computeKpis(current);
  if (!prior) return { current: cur, prior: null, deltas: {} };
  const pri = computeKpis(prior);
  const deltas: Record<string, Delta> = {};
  for (const { key, pick } of DELTA_KEYS) {
    deltas[key] = computeDelta(pick(cur) ?? 0, pick(pri) ?? 0);
  }
  return { current: cur, prior: pri, deltas };
}

// ── Runway (cash ÷ burn) ──────────────────────────────────────────────────────

export interface RunwayResult {
  cashCents: number;
  /** Cash consumed per month (>0). 0 when the business is cash-generating. */
  monthlyBurnCents: number;
  /** cashCents ÷ monthlyBurnCents, one decimal. null when NOT burning (runway is
   *  effectively infinite / the tenant is generating cash). */
  runwayMonths: number | null;
  /** True when average monthly net income over the window is ≥ 0. */
  cashGenerating: boolean;
  /** How many months of history the burn average is based on. */
  basisMonths: number;
}

/**
 * Monthly burn + cash runway.
 *
 * Burn = the average monthly cash consumption, estimated from the trailing net
 * income series (a proxy for operating cash burn — deterministic and matching
 * what the trend chart shows). When that average is ≥ 0 the tenant is generating
 * cash: burn is 0 and runway is null (not "infinite" numerics). When burning,
 * runway = cash ÷ burn. A non-positive cash balance while burning yields 0.
 */
export function computeRunway(
  cashCents: number,
  netIncomeSeriesCents: number[],
): RunwayResult {
  const series = netIncomeSeriesCents.filter((n) => Number.isFinite(n));
  const basisMonths = series.length;
  const avgNet = basisMonths > 0 ? series.reduce((s, n) => s + n, 0) / basisMonths : 0;

  if (avgNet >= 0) {
    return {
      cashCents,
      monthlyBurnCents: 0,
      runwayMonths: null,
      cashGenerating: true,
      basisMonths,
    };
  }

  const monthlyBurnCents = Math.round(-avgNet);
  const runwayMonths =
    monthlyBurnCents <= 0 ? null : cashCents <= 0 ? 0 : round1(cashCents / monthlyBurnCents);

  return {
    cashCents,
    monthlyBurnCents,
    runwayMonths,
    cashGenerating: false,
    basisMonths,
  };
}

// ── Variance: actual vs budget vs forecast ────────────────────────────────────

export interface PlanRow {
  key: string;
  label: string;
  section: PnlSection;
  actualCents: number;
  budgetCents: number;
  forecastCents: number;
}

export interface VarianceRow extends PlanRow {
  /** actual − budget (positive = ran above plan). */
  budgetVarianceCents: number;
  budgetVariancePct: number | null;
  /** forecast − budget (positive = latest estimate above plan). */
  forecastVarianceCents: number;
  forecastVariancePct: number | null;
  /** Favorability of actual-vs-budget: revenue above plan = good; cost above = bad.
   *  null when there is no movement. */
  favorable: boolean | null;
  /** Favorability of the FORECAST vs budget (the decision-useful full-year signal). */
  forecastFavorable: boolean | null;
}

export interface VarianceTotalRow {
  section: PnlSection | 'NET_INCOME';
  actualCents: number;
  budgetCents: number;
  forecastCents: number;
  budgetVarianceCents: number;
  budgetVariancePct: number | null;
  forecastVarianceCents: number;
  forecastVariancePct: number | null;
  favorable: boolean | null;
  forecastFavorable: boolean | null;
}

export interface PlanVarianceResult {
  rows: VarianceRow[];
  totalsBySection: VarianceTotalRow[];
  /** Roll-up: revenue − (COGS + OPEX + OTHER) for each of actual/budget/forecast. */
  netIncome: VarianceTotalRow;
}

const COST_SECTIONS: PnlSection[] = ['COGS', 'OPEX', 'OTHER'];

function varPct(varianceCents: number, baseCents: number): number | null {
  if (baseCents === 0) return null;
  return round2((varianceCents / Math.abs(baseCents)) * 100);
}

function favorabilityOf(section: PnlSection, actualCents: number, budgetCents: number): boolean | null {
  if (actualCents === budgetCents) return null;
  return section === 'REVENUE'
    ? actualCents > budgetCents
    : actualCents < budgetCents; // cost line: under plan is favorable
}

/**
 * Build the variance table: actual vs budget vs forecast per account line, plus
 * section subtotals and a net-income roll-up. Favorability is section-aware.
 */
export function computePlanVariance(rows: PlanRow[]): PlanVarianceResult {
  const varianceRows: VarianceRow[] = rows.map((r) => {
    const budgetVarianceCents = r.actualCents - r.budgetCents;
    const forecastVarianceCents = r.forecastCents - r.budgetCents;
    return {
      ...r,
      budgetVarianceCents,
      budgetVariancePct: varPct(budgetVarianceCents, r.budgetCents),
      forecastVarianceCents,
      forecastVariancePct: varPct(forecastVarianceCents, r.budgetCents),
      favorable: favorabilityOf(r.section, r.actualCents, r.budgetCents),
      forecastFavorable: favorabilityOf(r.section, r.forecastCents, r.budgetCents),
    };
  });

  const sections: PnlSection[] = ['REVENUE', 'COGS', 'OPEX', 'OTHER'];
  const totalsBySection: VarianceTotalRow[] = sections.map((section) => {
    const inSection = rows.filter((r) => r.section === section);
    const actualCents = inSection.reduce((s, r) => s + r.actualCents, 0);
    const budgetCents = inSection.reduce((s, r) => s + r.budgetCents, 0);
    const forecastCents = inSection.reduce((s, r) => s + r.forecastCents, 0);
    const budgetVarianceCents = actualCents - budgetCents;
    const forecastVarianceCents = forecastCents - budgetCents;
    return {
      section,
      actualCents,
      budgetCents,
      forecastCents,
      budgetVarianceCents,
      budgetVariancePct: varPct(budgetVarianceCents, budgetCents),
      forecastVarianceCents,
      forecastVariancePct: varPct(forecastVarianceCents, budgetCents),
      favorable: favorabilityOf(section, actualCents, budgetCents),
      forecastFavorable: favorabilityOf(section, forecastCents, budgetCents),
    };
  });

  // Net income = revenue − cost sections, for each scenario.
  const pick = (fn: (t: VarianceTotalRow) => number, s: PnlSection) =>
    fn(totalsBySection.find((t) => t.section === s)!);
  const netActual =
    pick((t) => t.actualCents, 'REVENUE') -
    COST_SECTIONS.reduce((s, sec) => s + pick((t) => t.actualCents, sec), 0);
  const netBudget =
    pick((t) => t.budgetCents, 'REVENUE') -
    COST_SECTIONS.reduce((s, sec) => s + pick((t) => t.budgetCents, sec), 0);
  const netForecast =
    pick((t) => t.forecastCents, 'REVENUE') -
    COST_SECTIONS.reduce((s, sec) => s + pick((t) => t.forecastCents, sec), 0);
  const netBudgetVariance = netActual - netBudget;
  const netForecastVariance = netForecast - netBudget;

  const netIncome: VarianceTotalRow = {
    section: 'NET_INCOME',
    actualCents: netActual,
    budgetCents: netBudget,
    forecastCents: netForecast,
    budgetVarianceCents: netBudgetVariance,
    budgetVariancePct: varPct(netBudgetVariance, netBudget),
    forecastVarianceCents: netForecastVariance,
    forecastVariancePct: varPct(netForecastVariance, netBudget),
    // Higher net income than plan is favorable.
    favorable: netActual === netBudget ? null : netActual > netBudget,
    forecastFavorable: netForecast === netBudget ? null : netForecast > netBudget,
  };

  return { rows: varianceRows, totalsBySection, netIncome };
}

// ── Trend series ──────────────────────────────────────────────────────────────

export interface TrendPointInput {
  label: string;
  pnl: PnlAggregate;
  /** End-of-period cash, if a balance snapshot is available for the month. */
  cashCents?: number | null;
}

export interface TrendPoint {
  label: string;
  revenueCents: number;
  grossProfitCents: number;
  operatingIncomeCents: number;
  netIncomeCents: number;
  grossMarginPct: number | null;
  netMarginPct: number | null;
  cashCents: number | null;
}

/** Derive a per-period trend series (revenue, profit tiers, margins, cash). */
export function computeTrend(points: TrendPointInput[]): TrendPoint[] {
  return points.map((p) => {
    const grossProfitCents = p.pnl.revenueCents - p.pnl.cogsCents;
    const operatingIncomeCents = grossProfitCents - p.pnl.opexCents;
    const netIncomeCents = operatingIncomeCents - p.pnl.otherCents;
    return {
      label: p.label,
      revenueCents: p.pnl.revenueCents,
      grossProfitCents,
      operatingIncomeCents,
      netIncomeCents,
      grossMarginPct: marginPct(grossProfitCents, p.pnl.revenueCents),
      netMarginPct: marginPct(netIncomeCents, p.pnl.revenueCents),
      cashCents: p.cashCents ?? null,
    };
  });
}
