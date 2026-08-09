/**
 * Job P&L composer — exact-cent assertions. Every expected number is computed by
 * hand from the formula, so this file is the correctness contract for the
 * per-job P&L and the portfolio WIP schedule roll-up. Fixtures are fixed (no I/O).
 */
import { describe, it, expect } from 'vitest';
import { computeJobPL, computeJobPLPortfolio, type JobPLInput } from './job-pl';

// A healthy job: $1.00M contract, $800k budget, half done by cost, billed to earned.
const HEALTHY: JobPLInput = {
  jobId: 'j1',
  jobNumber: '25-001',
  jobName: 'Healthy Tower',
  status: 'ACTIVE',
  company: 'AAA',
  contractValueCents: 1_000_000,
  originalContractCents: 900_000,
  approvedCoCents: 100_000,
  estimatedCostCents: 800_000,
  originalBudgetCents: 800_000,
  costsToDateCents: 400_000, // 50% by cost
  committedOpenCents: 100_000,
  billedToDateCents: 500_000, // exactly earned (contract 50%)
  revenueRecognizedCents: 500_000,
  retainageHeldCents: 50_000,
  glPostedCostsCents: 400_000, // ties
  categories: [
    { key: 'LABOR', label: 'Labor', budgetCents: 400_000, actualCents: 220_000 },
    { key: 'MATERIALS', label: 'Materials', budgetCents: 400_000, actualCents: 180_000 },
  ],
};

describe('computeJobPL — healthy job', () => {
  const r = computeJobPL(HEALTHY);

  it('earns revenue at cost-to-cost %-complete (50% × $1.00M)', () => {
    expect(r.costPctComplete).toBe(0.5);
    expect(r.pctBasis).toBe('COST_TO_COST');
    expect(r.earnedRevenueCents).toBe(500_000);
  });

  it('is on target when billed equals earned', () => {
    expect(r.overBillingCents).toBe(0);
    expect(r.underBillingCents).toBe(0);
    expect(r.wipStatus).toBe('ON_TARGET');
  });

  it('reports gross profit earned to date = earned − costs to date', () => {
    expect(r.grossProfitToDateCents).toBe(100_000); // 500k − 400k
    expect(r.grossMarginToDatePct).toBe(20); // 100k / 500k
  });

  it('projects EAC inside budget and a healthy final margin', () => {
    // COMMITMENTS: EAC = max(budget 800k, costs 400k + committed 100k) = 800k
    expect(r.eacCents).toBe(800_000);
    expect(r.costToCompleteCents).toBe(400_000);
    expect(r.projectedFinalMarginCents).toBe(200_000);
    expect(r.projectedFinalMarginPct).toBe(20);
    expect(r.projectedLoss).toBe(false);
    expect(r.marginFade).toBe(false);
    expect(r.overBudget).toBe(false);
  });

  it('splits contract into original + approved change orders', () => {
    expect(r.originalContractCents).toBe(900_000);
    expect(r.approvedCoCents).toBe(100_000);
  });

  it('ties book cost-to-date to the GL bridge', () => {
    expect(r.glCostTieDeltaCents).toBe(0);
    expect(r.glCostTied).toBe(true);
  });

  it('computes per-category variance and usage', () => {
    const labor = r.categories.find((c) => c.key === 'LABOR')!;
    expect(labor.varianceCents).toBe(180_000); // 400k − 220k favorable
    expect(labor.pctUsed).toBe(55);
    expect(labor.overBudget).toBe(false);
  });
});

// An underwater job: costs are blowing through the budget; it will finish at a loss.
const LOSS: JobPLInput = {
  jobId: 'j2',
  jobNumber: '25-002',
  jobName: 'Underwater Job',
  status: 'ACTIVE',
  company: 'BBB',
  contractValueCents: 1_000_000,
  originalContractCents: 1_000_000,
  approvedCoCents: 0,
  estimatedCostCents: 900_000,
  originalBudgetCents: 800_000, // original estimate was tighter → fade
  costsToDateCents: 950_000,
  committedOpenCents: 200_000, // committed floor 1,150,000 > contract
  billedToDateCents: 300_000, // badly underbilled vs earned
  glPostedCostsCents: 900_000, // book 950k vs GL 900k → untied by 50k
  categories: [
    { key: 'LABOR', label: 'Labor', budgetCents: 400_000, actualCents: 520_000 },
  ],
};

describe('computeJobPL — job heading to a loss', () => {
  const r = computeJobPL(LOSS);

  it('flags a projected loss (EAC > contract)', () => {
    // EAC = max(budget 900k, 950k + 200k committed) = 1,150,000
    expect(r.eacCents).toBe(1_150_000);
    expect(r.projectedFinalMarginCents).toBe(-150_000);
    expect(r.projectedLoss).toBe(true);
  });

  it('flags margin fade vs the original estimate', () => {
    // original margin 20% (contract 1.00M, orig budget 800k); projected −15% → fade
    expect(r.originalMarginPct).toBe(20);
    expect(r.projectedFinalMarginPct).toBe(-15);
    expect(r.marginFade).toBe(true);
    expect(r.marginFadeBps).toBe(3500);
  });

  it('flags a cost overrun vs the current budget', () => {
    expect(r.overBudget).toBe(true);
    expect(r.varianceVsBudgetCents).toBe(350_000); // EAC 1.15M − orig budget 800k
  });

  it('surfaces the GL tie break', () => {
    expect(r.glCostTieDeltaCents).toBe(50_000);
    expect(r.glCostTied).toBe(false);
  });

  it('is underbilled vs earned revenue', () => {
    expect(r.wipStatus).toBe('UNDERBILLED');
    expect(r.underBillingCents).toBeGreaterThan(0);
  });

  it('honors the GL tie tolerance when provided', () => {
    const tied = computeJobPL(LOSS, { glTieToleranceCents: 50_000 });
    expect(tied.glCostTied).toBe(true);
  });
});

describe('computeJobPL — physical %-complete override', () => {
  it('uses the physical fraction over cost-to-cost for earned revenue', () => {
    const r = computeJobPL({ ...HEALTHY, pctCompleteOverride: 0.8 });
    expect(r.pctBasis).toBe('PHYSICAL');
    expect(r.pctCompleteDisplay).toBe(80);
    expect(r.earnedRevenueCents).toBe(800_000);
    // cost %-complete is still reported independently (400k / 800k)
    expect(r.costPctComplete).toBe(0.5);
  });
});

describe('computeJobPLPortfolio — roll-up', () => {
  const p = computeJobPLPortfolio([HEALTHY, LOSS]);

  it('counts the schedule and its risk flags', () => {
    expect(p.totals.jobs).toBe(2);
    expect(p.totals.projectedLossJobs).toBe(1);
    expect(p.totals.marginFadeJobs).toBe(1);
    expect(p.totals.overBudgetJobs).toBe(1);
    expect(p.totals.underbilledJobs).toBe(1);
    expect(p.totals.glUntiedJobs).toBe(1);
  });

  it('sums contract, EAC, and projected margin exactly', () => {
    expect(p.totals.contractValueCents).toBe(2_000_000);
    expect(p.totals.eacCents).toBe(1_950_000); // 800k + 1.15M
    expect(p.totals.projectedFinalMarginCents).toBe(50_000); // 200k + (−150k)
    expect(p.totals.projectedFinalMarginPct).toBe(2.5); // 50k / 2.00M
  });

  it('accumulates the loss exposure as a positive number', () => {
    expect(p.totals.projectedLossExposureCents).toBe(150_000);
  });

  it('nets the WIP position (underbilled − overbilled)', () => {
    expect(p.totals.netWipCents).toBe(p.totals.underBillingCents - p.totals.overBillingCents);
  });
});
