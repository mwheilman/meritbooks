/**
 * WIP schedule computer — exact-cent assertions. Expected values are hand-computed
 * from the contractor WIP formula (earned = contract × %-complete; over/under =
 * billed vs earned). Fixed fixtures, no I/O.
 */
import { describe, it, expect } from 'vitest';
import { computeWipJob, computeWipSchedule, type WipJobInput } from './wip';

const UNDERBILLED: WipJobInput = {
  jobId: 'a',
  jobNumber: 'J-1',
  jobName: 'Under',
  contractValueCents: 1_000_000,
  estimatedCostCents: 800_000,
  costsToDateCents: 400_000, // cost-to-cost 50%
  billedToDateCents: 300_000,
};

const OVERBILLED: WipJobInput = {
  jobId: 'b',
  jobNumber: 'J-2',
  jobName: 'Over',
  contractValueCents: 1_000_000,
  estimatedCostCents: 800_000,
  costsToDateCents: 400_000,
  billedToDateCents: 700_000,
  pctCompleteOverride: 0.5, // physical 50%
};

const ON_TARGET: WipJobInput = {
  jobId: 'c',
  jobNumber: 'J-3',
  jobName: 'OnTarget',
  contractValueCents: 1_000_000,
  estimatedCostCents: 500_000,
  costsToDateCents: 250_000, // 50%
  billedToDateCents: 500_000,
};

describe('computeWipJob — under-billed (cost-to-cost basis)', () => {
  const r = computeWipJob(UNDERBILLED);
  it('earns contract × %-complete and shows costs in excess of billings', () => {
    expect(r.pctComplete).toBe(0.5);
    expect(r.pctBasis).toBe('COST_TO_COST');
    expect(r.earnedRevenueCents).toBe(500_000);
    expect(r.earnedGrossProfitCents).toBe(100_000); // GP 200k × 50%
    expect(r.underBillingCents).toBe(200_000);
    expect(r.overBillingCents).toBe(0);
    expect(r.wipStatus).toBe('UNDERBILLED');
  });
});

describe('computeWipJob — over-billed (physical override basis)', () => {
  const r = computeWipJob(OVERBILLED);
  it('shows billings in excess of earnings', () => {
    expect(r.pctBasis).toBe('PHYSICAL');
    expect(r.earnedRevenueCents).toBe(500_000);
    expect(r.overBillingCents).toBe(200_000);
    expect(r.underBillingCents).toBe(0);
    expect(r.netBillingPositionCents).toBe(200_000);
    expect(r.wipStatus).toBe('OVERBILLED');
  });
});

describe('computeWipJob — on target', () => {
  const r = computeWipJob(ON_TARGET);
  it('nets to zero', () => {
    expect(r.earnedRevenueCents).toBe(500_000);
    expect(r.overBillingCents).toBe(0);
    expect(r.underBillingCents).toBe(0);
    expect(r.wipStatus).toBe('ON_TARGET');
  });
});

describe('computeWipJob — rounding + tolerance', () => {
  it('rounds earned revenue to whole cents', () => {
    const r = computeWipJob({
      jobId: 'd',
      jobNumber: 'J-4',
      jobName: 'Round',
      contractValueCents: 1_000_000,
      estimatedCostCents: 300_000,
      costsToDateCents: 100_000, // 33.333% → earned 333,333
      billedToDateCents: 0,
    });
    expect(r.earnedRevenueCents).toBe(333_333);
    expect(r.underBillingCents).toBe(333_333);
  });
  it('treats a small billed/earned gap inside tolerance as ON_TARGET', () => {
    const r = computeWipJob(
      { ...ON_TARGET, billedToDateCents: 500_050 },
      { toleranceCents: 100 },
    );
    expect(r.overBillingCents).toBe(50); // still reported as a figure
    expect(r.wipStatus).toBe('ON_TARGET');
  });
});

describe('computeWipSchedule — portfolio roll-up', () => {
  const s = computeWipSchedule([UNDERBILLED, OVERBILLED, ON_TARGET]);
  it('sums the schedule columns', () => {
    expect(s.totals.jobs).toBe(3);
    expect(s.totals.contractValueCents).toBe(3_000_000);
    expect(s.totals.estimatedCostCents).toBe(2_100_000);
    expect(s.totals.estimatedGrossProfitCents).toBe(900_000);
    expect(s.totals.costsToDateCents).toBe(1_050_000);
    expect(s.totals.earnedRevenueCents).toBe(1_500_000);
    expect(s.totals.billedToDateCents).toBe(1_500_000);
  });
  it('nets over vs under billing', () => {
    expect(s.totals.overBillingCents).toBe(200_000);
    expect(s.totals.underBillingCents).toBe(200_000);
    expect(s.totals.netWipCents).toBe(0);
    expect(s.totals.overbilledJobs).toBe(1);
    expect(s.totals.underbilledJobs).toBe(1);
  });
});
