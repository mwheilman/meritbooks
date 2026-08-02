/**
 * Estimate-at-Completion (EAC) / cost-to-complete computer — PURE, deterministic.
 *
 * Construction-finance core: given a job's contract value, budget, costs-to-date,
 * open commitments, and (optionally) a physical %-complete, this projects the
 * final cost (EAC), the cost still to spend, the estimated final margin, and the
 * variance vs the original budget — and flags jobs that are projecting a loss or
 * whose margin is fading vs the original estimate.
 *
 * INVARIANT (canon §3): numbers are authored HERE, in code. The AI gateway is only
 * ever used to *phrase* these figures for a human; it never authors a cent. This
 * module has no I/O, no clock, no randomness — same inputs → same outputs, so the
 * unit tests (eac.test.ts) are the correctness guarantee.
 *
 * All money is integer cents (canon: bigint cents; we operate on JS numbers, which
 * are exact for cent magnitudes well under 2^53).
 */

/** How the EAC is projected. */
export type EacMethod =
  /** EAC = max(budget, costs-to-date). Overrun only shows once actuals exceed budget. */
  | 'COST_TO_COST'
  /** EAC = max(budget, costs-to-date + open commitments). Commitments pull the overrun forward. */
  | 'COMMITMENTS'
  /** EAC = costs-to-date / physical-%-complete (CPI-style), floored at committed spend. Reveals fade earliest. */
  | 'PROGRESS';

export interface EacInput {
  /** Current contract value in cents, INCLUDING approved change orders (revenue). */
  contractValueCents: number;
  /** Original estimated total cost baseline (for variance-vs-budget), cents. */
  originalBudgetCents: number;
  /** Current estimated total cost (the working budget / EAC baseline), cents. */
  budgetCents: number;
  /** Actual cost incurred (cleared) to date, cents. */
  costsToDateCents: number;
  /** Open committed cost not yet incurred (POs/subcontracts awaiting bill), cents. >= 0. */
  committedOpenCents: number;
  /**
   * Physical / schedule %-complete as a FRACTION in [0,1], from a JOB_PROGRESS
   * snapshot. Only consulted by the PROGRESS method; null/omitted → cost-to-cost.
   */
  progressPctComplete?: number | null;
}

export interface EacOptions {
  method?: EacMethod;
  /** Margin-fade alarm threshold, in basis points of margin %. Default 200 bps (2.0 pts). */
  fadeThresholdBps?: number;
}

export interface EacResult {
  method: EacMethod;
  contractValueCents: number;
  originalBudgetCents: number;
  budgetCents: number;
  costsToDateCents: number;
  committedOpenCents: number;
  /** %-complete used to project the EAC, as a fraction [0,1]. */
  pctComplete: number;
  /** Same, as a 0–100 percentage rounded to 1 decimal (display). */
  pctCompleteDisplay: number;
  /** Cost-to-cost %-complete (costs ÷ budget), fraction [0,1] — always reported. */
  costPctComplete: number;
  /** Remaining cost to finish = EAC − costs-to-date (never negative), cents. */
  costToCompleteCents: number;
  /** Estimate at completion (projected FINAL total cost), cents. */
  eacCents: number;
  /** Projected final margin = contract − EAC, cents (can be negative). */
  estimatedFinalMarginCents: number;
  /** Projected final margin % of contract (1 decimal); null if no contract value. */
  estimatedFinalMarginPct: number | null;
  /** Original margin = contract − original budget, cents. */
  originalMarginCents: number;
  /** Original margin % of contract (1 decimal); null if no contract value. */
  originalMarginPct: number | null;
  /** EAC − original budget, cents. Positive = cost overrun vs the original estimate. */
  varianceVsBudgetCents: number;
  /** Margin erosion vs original, in basis points. Positive = fade (margin shrank). */
  marginFadeBps: number;
  /** Projected final margin is negative. */
  projectedLoss: boolean;
  /** Margin fade meets/exceeds the alarm threshold. */
  marginFade: boolean;
}

function clampFraction(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0;
  return x >= 1 ? 1 : x;
}

/** Round to whole cents, treating non-finite as 0. */
function cents(x: number): number {
  return Number.isFinite(x) ? Math.round(x) : 0;
}

/** Margin % of contract to 1 decimal; null when there is no contract value. */
function marginPct(marginCents: number, contractCents: number): number | null {
  if (contractCents <= 0) return null;
  return Math.round((marginCents / contractCents) * 1000) / 10;
}

/**
 * Compute the estimate-at-completion for a single job. Pure.
 */
export function computeEac(input: EacInput, options: EacOptions = {}): EacResult {
  const method: EacMethod = options.method ?? 'COMMITMENTS';
  const fadeThresholdBps = options.fadeThresholdBps ?? 200;

  const contract = Math.max(0, cents(input.contractValueCents));
  const originalBudget = Math.max(0, cents(input.originalBudgetCents));
  const budget = Math.max(0, cents(input.budgetCents));
  const costsToDate = Math.max(0, cents(input.costsToDateCents));
  const committedOpen = Math.max(0, cents(input.committedOpenCents));

  // Cost-to-cost %-complete is always reported (it is the fallback basis too).
  const costPctComplete = budget > 0 ? clampFraction(costsToDate / budget) : 0;
  const progressPct =
    input.progressPctComplete == null ? null : clampFraction(input.progressPctComplete);

  // Project the EAC by method. Every branch floors the EAC at spend actually
  // committed (costs-to-date + open commitments) — you can never finish for less
  // than what is already committed.
  const committedFloor = costsToDate + committedOpen;
  let eac: number;
  let pctUsed: number;

  if (method === 'PROGRESS') {
    pctUsed = progressPct != null && progressPct > 0 ? progressPct : costPctComplete;
    const cpiProjection = pctUsed > 0 ? costsToDate / pctUsed : budget;
    eac = Math.max(cents(cpiProjection), committedFloor, budget > 0 ? 0 : committedFloor);
    // When there is no measured progress AND no budget, fall back to the floor.
    if (pctUsed <= 0) eac = Math.max(budget, committedFloor);
  } else if (method === 'COMMITMENTS') {
    pctUsed = costPctComplete;
    eac = Math.max(budget, committedFloor);
  } else {
    // COST_TO_COST
    pctUsed = costPctComplete;
    eac = Math.max(budget, costsToDate);
  }

  eac = cents(eac);
  const costToComplete = Math.max(0, eac - costsToDate);

  const estimatedFinalMargin = contract - eac;
  const originalMargin = contract - originalBudget;
  const estimatedFinalMarginPct = marginPct(estimatedFinalMargin, contract);
  const originalMarginPct = marginPct(originalMargin, contract);

  // Fade = original margin % minus projected margin %, expressed in basis points.
  const marginFadeBps =
    estimatedFinalMarginPct != null && originalMarginPct != null
      ? Math.round((originalMarginPct - estimatedFinalMarginPct) * 100)
      : 0;

  const projectedLoss = estimatedFinalMargin < 0;
  const marginFade =
    estimatedFinalMarginPct != null &&
    originalMarginPct != null &&
    marginFadeBps >= fadeThresholdBps;

  return {
    method,
    contractValueCents: contract,
    originalBudgetCents: originalBudget,
    budgetCents: budget,
    costsToDateCents: costsToDate,
    committedOpenCents: committedOpen,
    pctComplete: pctUsed,
    pctCompleteDisplay: Math.round(pctUsed * 1000) / 10,
    costPctComplete,
    costToCompleteCents: costToComplete,
    eacCents: eac,
    estimatedFinalMarginCents: estimatedFinalMargin,
    estimatedFinalMarginPct,
    originalMarginCents: originalMargin,
    originalMarginPct,
    varianceVsBudgetCents: eac - originalBudget,
    marginFadeBps,
    projectedLoss,
    marginFade,
  };
}

export interface EacPortfolioTotals {
  jobs: number;
  contractValueCents: number;
  eacCents: number;
  costsToDateCents: number;
  costToCompleteCents: number;
  estimatedFinalMarginCents: number;
  estimatedFinalMarginPct: number | null;
  projectedLossJobs: number;
  marginFadeJobs: number;
  projectedLossExposureCents: number; // sum of negative projected margins (as a positive number)
}

/** Roll a set of per-job EAC results into a portfolio summary. Pure. */
export function rollupEac(results: EacResult[]): EacPortfolioTotals {
  const t: EacPortfolioTotals = {
    jobs: results.length,
    contractValueCents: 0,
    eacCents: 0,
    costsToDateCents: 0,
    costToCompleteCents: 0,
    estimatedFinalMarginCents: 0,
    estimatedFinalMarginPct: null,
    projectedLossJobs: 0,
    marginFadeJobs: 0,
    projectedLossExposureCents: 0,
  };
  for (const r of results) {
    t.contractValueCents += r.contractValueCents;
    t.eacCents += r.eacCents;
    t.costsToDateCents += r.costsToDateCents;
    t.costToCompleteCents += r.costToCompleteCents;
    t.estimatedFinalMarginCents += r.estimatedFinalMarginCents;
    if (r.projectedLoss) {
      t.projectedLossJobs += 1;
      t.projectedLossExposureCents += -r.estimatedFinalMarginCents;
    }
    if (r.marginFade) t.marginFadeJobs += 1;
  }
  t.estimatedFinalMarginPct = marginPct(t.estimatedFinalMarginCents, t.contractValueCents);
  return t;
}
