/**
 * Work-in-Progress (WIP) over/under-billing schedule — PURE, deterministic.
 *
 * The classic contractor WIP schedule. Per job it computes, from the current
 * contract value and estimated total cost:
 *   - %-complete (physical override, else cost-to-cost = costs ÷ estimated cost)
 *   - earned revenue ("costs & estimated earnings") = contract × %-complete
 *   - over-billing  = billings IN EXCESS OF costs & earnings  (billed − earned > 0)
 *                     → a LIABILITY (deferred revenue / contract liability, 2410)
 *   - under-billing = costs & earnings IN EXCESS OF billings  (earned − billed > 0)
 *                     → an ASSET (unbilled / contract asset, 1180)
 * ...and rolls those up across the portfolio.
 *
 * INVARIANT (canon §3): every figure is authored here, in code — the ledger and
 * the deterministic engine own the accounting; the AI never authors a cent. No
 * I/O, no clock: same inputs → same outputs. wip.test.ts is the guarantee.
 *
 * All money is integer cents.
 */

export interface WipJobInput {
  jobId: string;
  jobNumber: string;
  jobName: string;
  status?: string | null;
  /** Short entity/company code for display roll-up. */
  company?: string | null;
  /** Current contract value in cents, INCLUDING approved change orders. */
  contractValueCents: number;
  /** Estimated total cost at completion (EAC baseline), cents. */
  estimatedCostCents: number;
  /** Actual cost incurred to date, cents. */
  costsToDateCents: number;
  /** Amount billed to the customer to date, cents. */
  billedToDateCents: number;
  /**
   * Physical %-complete as a FRACTION in [0,1] (e.g. from a JOB_PROGRESS
   * snapshot). When null/omitted or <= 0, cost-to-cost is used instead.
   */
  pctCompleteOverride?: number | null;
}

export interface WipOptions {
  /** Band (cents) within which billed≈earned counts as ON_TARGET. Default 0. */
  toleranceCents?: number;
}

export type WipStatus = 'OVERBILLED' | 'UNDERBILLED' | 'ON_TARGET';

export interface WipJobResult {
  jobId: string;
  jobNumber: string;
  jobName: string;
  status: string | null;
  company: string | null;
  contractValueCents: number;
  estimatedCostCents: number;
  costsToDateCents: number;
  /** %-complete used, fraction [0,1]. */
  pctComplete: number;
  /** Same, 0–100 (1 decimal). */
  pctCompleteDisplay: number;
  /** Whether the % came from a physical override or was derived cost-to-cost. */
  pctBasis: 'PHYSICAL' | 'COST_TO_COST';
  estimatedGrossProfitCents: number;
  /** Earned revenue = contract × %-complete, cents. */
  earnedRevenueCents: number;
  /** Earned gross profit recognized to date = est. GP × %-complete, cents. */
  earnedGrossProfitCents: number;
  billedToDateCents: number;
  /** Billings in excess of costs & earnings (liability), cents. >= 0. */
  overBillingCents: number;
  /** Costs & earnings in excess of billings (asset), cents. >= 0. */
  underBillingCents: number;
  /** billed − earned, cents (signed; positive = overbilled). */
  netBillingPositionCents: number;
  wipStatus: WipStatus;
}

export interface WipTotals {
  jobs: number;
  contractValueCents: number;
  estimatedCostCents: number;
  estimatedGrossProfitCents: number;
  costsToDateCents: number;
  earnedRevenueCents: number;
  billedToDateCents: number;
  overBillingCents: number;
  underBillingCents: number;
  /** underBilling − overBilling, cents (net contract asset position). */
  netWipCents: number;
  overbilledJobs: number;
  underbilledJobs: number;
}

export interface WipSchedule {
  jobs: WipJobResult[];
  totals: WipTotals;
}

function clampFraction(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0;
  return x >= 1 ? 1 : x;
}

function cents(x: number): number {
  return Number.isFinite(x) ? Math.round(x) : 0;
}

/** Compute the WIP line for one job. Pure. */
export function computeWipJob(input: WipJobInput, options: WipOptions = {}): WipJobResult {
  const tolerance = Math.max(0, cents(options.toleranceCents ?? 0));

  const contract = Math.max(0, cents(input.contractValueCents));
  const estCost = Math.max(0, cents(input.estimatedCostCents));
  const costsToDate = Math.max(0, cents(input.costsToDateCents));
  const billed = Math.max(0, cents(input.billedToDateCents));

  const override =
    input.pctCompleteOverride == null ? null : clampFraction(input.pctCompleteOverride);
  const costToCost = estCost > 0 ? clampFraction(costsToDate / estCost) : 0;

  const usePhysical = override != null && override > 0;
  const pct = usePhysical ? override : costToCost;

  const estimatedGrossProfit = contract - estCost;
  const earnedRevenue = cents(contract * pct);
  const earnedGrossProfit = cents(estimatedGrossProfit * pct);

  const net = billed - earnedRevenue;
  const overBilling = net > 0 ? net : 0;
  const underBilling = net < 0 ? -net : 0;

  let wipStatus: WipStatus = 'ON_TARGET';
  if (net > tolerance) wipStatus = 'OVERBILLED';
  else if (-net > tolerance) wipStatus = 'UNDERBILLED';

  return {
    jobId: input.jobId,
    jobNumber: input.jobNumber,
    jobName: input.jobName,
    status: input.status ?? null,
    company: input.company ?? null,
    contractValueCents: contract,
    estimatedCostCents: estCost,
    costsToDateCents: costsToDate,
    pctComplete: pct,
    pctCompleteDisplay: Math.round(pct * 1000) / 10,
    pctBasis: usePhysical ? 'PHYSICAL' : 'COST_TO_COST',
    estimatedGrossProfitCents: estimatedGrossProfit,
    earnedRevenueCents: earnedRevenue,
    earnedGrossProfitCents: earnedGrossProfit,
    billedToDateCents: billed,
    overBillingCents: overBilling,
    underBillingCents: underBilling,
    netBillingPositionCents: net,
    wipStatus,
  };
}

/** Build the full WIP schedule for a set of jobs, with the portfolio roll-up. Pure. */
export function computeWipSchedule(
  inputs: WipJobInput[],
  options: WipOptions = {},
): WipSchedule {
  const jobs = inputs.map((j) => computeWipJob(j, options));
  const totals: WipTotals = {
    jobs: jobs.length,
    contractValueCents: 0,
    estimatedCostCents: 0,
    estimatedGrossProfitCents: 0,
    costsToDateCents: 0,
    earnedRevenueCents: 0,
    billedToDateCents: 0,
    overBillingCents: 0,
    underBillingCents: 0,
    netWipCents: 0,
    overbilledJobs: 0,
    underbilledJobs: 0,
  };
  for (const j of jobs) {
    totals.contractValueCents += j.contractValueCents;
    totals.estimatedCostCents += j.estimatedCostCents;
    totals.estimatedGrossProfitCents += j.estimatedGrossProfitCents;
    totals.costsToDateCents += j.costsToDateCents;
    totals.earnedRevenueCents += j.earnedRevenueCents;
    totals.billedToDateCents += j.billedToDateCents;
    totals.overBillingCents += j.overBillingCents;
    totals.underBillingCents += j.underBillingCents;
    if (j.wipStatus === 'OVERBILLED') totals.overbilledJobs += 1;
    else if (j.wipStatus === 'UNDERBILLED') totals.underbilledJobs += 1;
  }
  totals.netWipCents = totals.underBillingCents - totals.overBillingCents;
  return { jobs, totals };
}
