/**
 * Per-job P&L + portfolio WIP schedule composer — PURE, deterministic.
 *
 * This module does NOT re-derive the job-costing engine. It COMPOSES the two
 * authored, unit-tested primitives —
 *   • lib/jobcost/wip.ts  (earned-revenue / over-under-billing accounting)
 *   • lib/jobcost/eac.ts  (estimate-at-completion / margin-fade forecast)
 * — into a single contractor Job P&L (percentage-of-completion form) and rolls a
 * set of jobs up into the portfolio WIP schedule the field/office actually reads.
 *
 * The Job P&L is the statement a construction controller ties to the GL:
 *   Revenue side   — contract value (= original + approved COs), earned revenue
 *                    (POC), billed-to-date, over/under-billing, retainage held.
 *   Cost side      — costs to date by category, open commitments, EAC,
 *                    cost-to-complete, %-complete by cost.
 *   Margin         — gross profit earned to date, projected final margin, and the
 *                    fade vs the original estimate.
 *   GL tie-out     — book cost-to-date (the job record) reconciled to the sum of
 *                    GL-posted job-cost bridge rows; revenue recognized to the GL.
 *
 * INVARIANT (canon §3): every cent is authored here / in the composed primitives,
 * in code. No I/O, no clock, no randomness — same inputs → same outputs, so
 * job-pl.test.ts is the correctness guarantee. All money is integer cents.
 */

import { computeWipJob, type WipJobResult, type WipStatus } from '@/lib/jobcost/wip';
import { computeEac, type EacResult, type EacMethod } from '@/lib/jobcost/eac';

export interface JobPLCategoryInput {
  key: string;
  label: string;
  budgetCents: number;
  actualCents: number;
}

export interface JobPLCategory {
  key: string;
  label: string;
  budgetCents: number;
  actualCents: number;
  /** budget − actual, cents (positive = under budget / favorable). */
  varianceCents: number;
  /** actual ÷ budget as a 0–100 % (1 decimal); null when there is no budget. */
  pctUsed: number | null;
  /** actual has exceeded budget for this category. */
  overBudget: boolean;
}

export interface JobPLInput {
  jobId: string;
  jobNumber: string;
  jobName: string;
  status?: string | null;
  /** Short entity/company code for portfolio roll-up display. */
  company?: string | null;

  /** Current contract value in cents, INCLUDING approved change orders. */
  contractValueCents: number;
  /** Contract at job creation, before change orders, cents. */
  originalContractCents?: number | null;
  /** Running total of approved change-order amounts, cents. */
  approvedCoCents?: number | null;

  /** Current estimated total cost (working budget / EAC baseline), cents. */
  estimatedCostCents: number;
  /** Original detailed budget baseline (for variance-vs-budget), cents. */
  originalBudgetCents?: number | null;

  /** Actual (cleared) cost incurred to date, cents. */
  costsToDateCents: number;
  /** Open committed cost not yet incurred (POs/subs awaiting bill), cents. >= 0. */
  committedOpenCents?: number | null;

  /** Amount billed to the customer to date, cents. */
  billedToDateCents: number;
  /** Revenue recognized to the GL to date (rev-rec engine), cents. */
  revenueRecognizedCents?: number | null;
  /** Retainage held back on billings to date, cents. */
  retainageHeldCents?: number | null;

  /** Sum of GL-posted job-cost bridge rows for this job, cents — the GL tie. */
  glPostedCostsCents?: number | null;

  /** Physical %-complete as a FRACTION in [0,1]; null/<=0 → cost-to-cost. */
  pctCompleteOverride?: number | null;

  /** Costs to date broken out by category (labor/materials/sub/other/…). */
  categories?: JobPLCategoryInput[];
}

export interface JobPLOptions {
  /** EAC projection method. Default COMMITMENTS. */
  eacMethod?: EacMethod;
  /** Margin-fade alarm threshold in basis points. Default 200 (2.0 pts). */
  fadeThresholdBps?: number;
  /** Over/under band (cents) for WIP status. Default 0. */
  toleranceCents?: number;
  /** GL cost tie-out band (cents). |book − GL| within this ties. Default 0. */
  glTieToleranceCents?: number;
}

export interface JobPLResult {
  jobId: string;
  jobNumber: string;
  jobName: string;
  status: string | null;
  company: string | null;

  // ── Revenue side ────────────────────────────────────────────────────────────
  contractValueCents: number;
  originalContractCents: number;
  approvedCoCents: number;
  earnedRevenueCents: number;
  billedToDateCents: number;
  revenueRecognizedCents: number;
  retainageHeldCents: number;
  overBillingCents: number;
  underBillingCents: number;
  /** billed − earned, cents (positive = overbilled). */
  netBillingPositionCents: number;
  wipStatus: WipStatus;

  // ── Cost side ───────────────────────────────────────────────────────────────
  categories: JobPLCategory[];
  estimatedCostCents: number;
  costsToDateCents: number;
  committedOpenCents: number;
  eacCents: number;
  costToCompleteCents: number;
  /** costs ÷ estimated cost as a fraction [0,1] — %-complete by cost. */
  costPctComplete: number;
  costPctCompleteDisplay: number;
  /** %-complete used for recognition (physical override or cost-to-cost). */
  pctComplete: number;
  pctCompleteDisplay: number;
  pctBasis: 'PHYSICAL' | 'COST_TO_COST';

  // ── Margin ──────────────────────────────────────────────────────────────────
  /** Gross profit earned to date = earned revenue − costs to date, cents. */
  grossProfitToDateCents: number;
  /** GP-to-date ÷ earned revenue, 0–100 % (1 decimal); null if no earned rev. */
  grossMarginToDatePct: number | null;
  /** Estimated GP at current budget = contract − estimated cost, cents. */
  estimatedGrossProfitCents: number;
  /** Projected final margin = contract − EAC, cents (can be negative). */
  projectedFinalMarginCents: number;
  projectedFinalMarginPct: number | null;
  originalMarginCents: number;
  originalMarginPct: number | null;
  /** Margin erosion vs original, basis points (positive = fade). */
  marginFadeBps: number;
  /** EAC − original budget, cents (positive = cost overrun vs estimate). */
  varianceVsBudgetCents: number;

  // ── Flags ───────────────────────────────────────────────────────────────────
  /** Projected final margin < 0 (EAC > contract). */
  projectedLoss: boolean;
  /** Margin fade meets/exceeds the alarm threshold. */
  marginFade: boolean;
  /** EAC exceeds the current estimated cost (projected cost overrun). */
  overBudget: boolean;

  // ── GL tie-out ──────────────────────────────────────────────────────────────
  glPostedCostsCents: number;
  /** book cost-to-date − GL-posted job costs, cents (0 = tied). */
  glCostTieDeltaCents: number;
  glCostTied: boolean;

  /** Raw composed sub-results, for drill-downs. */
  wip: WipJobResult;
  eac: EacResult;
}

function cents(x: number | null | undefined): number {
  const n = Number(x ?? 0);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function marginPct(marginCents: number, contractCents: number): number | null {
  if (contractCents <= 0) return null;
  return Math.round((marginCents / contractCents) * 1000) / 10;
}

/** Compose the full Job P&L for one job. Pure. */
export function computeJobPL(input: JobPLInput, options: JobPLOptions = {}): JobPLResult {
  const eacMethod: EacMethod = options.eacMethod ?? 'COMMITMENTS';
  const glTieTolerance = Math.max(0, cents(options.glTieToleranceCents ?? 0));

  const contract = Math.max(0, cents(input.contractValueCents));
  const estimatedCost = Math.max(0, cents(input.estimatedCostCents));
  const costsToDate = Math.max(0, cents(input.costsToDateCents));
  const committedOpen = Math.max(0, cents(input.committedOpenCents));
  const billed = Math.max(0, cents(input.billedToDateCents));
  const originalBudget = Math.max(0, cents(input.originalBudgetCents ?? input.estimatedCostCents));

  const wip = computeWipJob(
    {
      jobId: input.jobId,
      jobNumber: input.jobNumber,
      jobName: input.jobName,
      status: input.status,
      company: input.company,
      contractValueCents: contract,
      estimatedCostCents: estimatedCost,
      costsToDateCents: costsToDate,
      billedToDateCents: billed,
      pctCompleteOverride: input.pctCompleteOverride,
    },
    options.toleranceCents != null ? { toleranceCents: options.toleranceCents } : {},
  );

  const eac = computeEac(
    {
      contractValueCents: contract,
      originalBudgetCents: originalBudget,
      budgetCents: estimatedCost,
      costsToDateCents: costsToDate,
      committedOpenCents: committedOpen,
      progressPctComplete: input.pctCompleteOverride ?? null,
    },
    options.fadeThresholdBps != null
      ? { method: eacMethod, fadeThresholdBps: options.fadeThresholdBps }
      : { method: eacMethod },
  );

  const categories: JobPLCategory[] = (input.categories ?? []).map((c) => {
    const budget = cents(c.budgetCents);
    const actual = cents(c.actualCents);
    return {
      key: c.key,
      label: c.label,
      budgetCents: budget,
      actualCents: actual,
      varianceCents: budget - actual,
      pctUsed: budget > 0 ? Math.round((actual / budget) * 1000) / 10 : null,
      overBudget: budget > 0 && actual > budget,
    };
  });

  const grossProfitToDate = wip.earnedRevenueCents - costsToDate;
  const grossMarginToDatePct =
    wip.earnedRevenueCents > 0
      ? Math.round((grossProfitToDate / wip.earnedRevenueCents) * 1000) / 10
      : null;

  const glPostedCosts = cents(input.glPostedCostsCents);
  const glCostTieDelta = costsToDate - glPostedCosts;

  return {
    jobId: input.jobId,
    jobNumber: input.jobNumber,
    jobName: input.jobName,
    status: input.status ?? null,
    company: input.company ?? null,

    contractValueCents: contract,
    originalContractCents: Math.max(0, cents(input.originalContractCents ?? contract - cents(input.approvedCoCents))),
    approvedCoCents: cents(input.approvedCoCents),
    earnedRevenueCents: wip.earnedRevenueCents,
    billedToDateCents: billed,
    revenueRecognizedCents: cents(input.revenueRecognizedCents),
    retainageHeldCents: cents(input.retainageHeldCents),
    overBillingCents: wip.overBillingCents,
    underBillingCents: wip.underBillingCents,
    netBillingPositionCents: wip.netBillingPositionCents,
    wipStatus: wip.wipStatus,

    categories,
    estimatedCostCents: estimatedCost,
    costsToDateCents: costsToDate,
    committedOpenCents: committedOpen,
    eacCents: eac.eacCents,
    costToCompleteCents: eac.costToCompleteCents,
    costPctComplete: eac.costPctComplete,
    costPctCompleteDisplay: Math.round(eac.costPctComplete * 1000) / 10,
    pctComplete: wip.pctComplete,
    pctCompleteDisplay: wip.pctCompleteDisplay,
    pctBasis: wip.pctBasis,

    grossProfitToDateCents: grossProfitToDate,
    grossMarginToDatePct,
    estimatedGrossProfitCents: wip.estimatedGrossProfitCents,
    projectedFinalMarginCents: eac.estimatedFinalMarginCents,
    projectedFinalMarginPct: eac.estimatedFinalMarginPct,
    originalMarginCents: eac.originalMarginCents,
    originalMarginPct: eac.originalMarginPct,
    marginFadeBps: eac.marginFadeBps,
    varianceVsBudgetCents: eac.varianceVsBudgetCents,

    projectedLoss: eac.projectedLoss,
    marginFade: eac.marginFade,
    overBudget: eac.eacCents > estimatedCost && estimatedCost > 0,

    glPostedCostsCents: glPostedCosts,
    glCostTieDeltaCents: glCostTieDelta,
    glCostTied: Math.abs(glCostTieDelta) <= glTieTolerance,

    wip,
    eac,
  };
}

export interface JobPLPortfolioTotals {
  jobs: number;
  contractValueCents: number;
  estimatedCostCents: number;
  costsToDateCents: number;
  committedOpenCents: number;
  eacCents: number;
  costToCompleteCents: number;
  earnedRevenueCents: number;
  billedToDateCents: number;
  revenueRecognizedCents: number;
  overBillingCents: number;
  underBillingCents: number;
  /** underBilling − overBilling, cents (net contract-asset position). */
  netWipCents: number;
  /** Projected final gross profit across the portfolio, cents. */
  projectedFinalMarginCents: number;
  /** Portfolio projected final margin % of contract; null if no contract value. */
  projectedFinalMarginPct: number | null;
  overbilledJobs: number;
  underbilledJobs: number;
  projectedLossJobs: number;
  marginFadeJobs: number;
  overBudgetJobs: number;
  /** Sum of negative projected margins as a positive number, cents. */
  projectedLossExposureCents: number;
  /** Jobs whose book cost does not tie to the GL bridge. */
  glUntiedJobs: number;
}

export interface JobPLPortfolio {
  jobs: JobPLResult[];
  totals: JobPLPortfolioTotals;
}

/** Compose the portfolio WIP schedule + roll-up from a set of jobs. Pure. */
export function computeJobPLPortfolio(
  inputs: JobPLInput[],
  options: JobPLOptions = {},
): JobPLPortfolio {
  const jobs = inputs.map((j) => computeJobPL(j, options));
  const totals: JobPLPortfolioTotals = {
    jobs: jobs.length,
    contractValueCents: 0,
    estimatedCostCents: 0,
    costsToDateCents: 0,
    committedOpenCents: 0,
    eacCents: 0,
    costToCompleteCents: 0,
    earnedRevenueCents: 0,
    billedToDateCents: 0,
    revenueRecognizedCents: 0,
    overBillingCents: 0,
    underBillingCents: 0,
    netWipCents: 0,
    projectedFinalMarginCents: 0,
    projectedFinalMarginPct: null,
    overbilledJobs: 0,
    underbilledJobs: 0,
    projectedLossJobs: 0,
    marginFadeJobs: 0,
    overBudgetJobs: 0,
    projectedLossExposureCents: 0,
    glUntiedJobs: 0,
  };
  for (const j of jobs) {
    totals.contractValueCents += j.contractValueCents;
    totals.estimatedCostCents += j.estimatedCostCents;
    totals.costsToDateCents += j.costsToDateCents;
    totals.committedOpenCents += j.committedOpenCents;
    totals.eacCents += j.eacCents;
    totals.costToCompleteCents += j.costToCompleteCents;
    totals.earnedRevenueCents += j.earnedRevenueCents;
    totals.billedToDateCents += j.billedToDateCents;
    totals.revenueRecognizedCents += j.revenueRecognizedCents;
    totals.overBillingCents += j.overBillingCents;
    totals.underBillingCents += j.underBillingCents;
    totals.projectedFinalMarginCents += j.projectedFinalMarginCents;
    if (j.wipStatus === 'OVERBILLED') totals.overbilledJobs += 1;
    else if (j.wipStatus === 'UNDERBILLED') totals.underbilledJobs += 1;
    if (j.projectedLoss) {
      totals.projectedLossJobs += 1;
      totals.projectedLossExposureCents += -j.projectedFinalMarginCents;
    }
    if (j.marginFade) totals.marginFadeJobs += 1;
    if (j.overBudget) totals.overBudgetJobs += 1;
    if (!j.glCostTied) totals.glUntiedJobs += 1;
  }
  totals.netWipCents = totals.underBillingCents - totals.overBillingCents;
  totals.projectedFinalMarginPct = marginPct(totals.projectedFinalMarginCents, totals.contractValueCents);
  return { jobs, totals };
}
