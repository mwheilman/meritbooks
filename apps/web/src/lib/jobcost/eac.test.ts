/**
 * EAC computer — exact-cent assertions. Every expected number below is computed
 * by hand from the formula, so this file is the correctness contract for
 * cost-to-complete / estimate-at-completion. Fixtures are fixed (no I/O).
 */
import { describe, it, expect } from 'vitest';
import { computeEac, rollupEac, type EacInput, type EacResult } from './eac';

// A healthy job, on budget, half done (commitments method — the default).
const HEALTHY: EacInput = {
  contractValueCents: 1_000_000,
  originalBudgetCents: 800_000,
  budgetCents: 800_000,
  costsToDateCents: 400_000,
  committedOpenCents: 100_000,
};

describe('computeEac — healthy job (COMMITMENTS default)', () => {
  const r = computeEac(HEALTHY);
  it('projects EAC = budget when commitments fit inside it', () => {
    expect(r.method).toBe('COMMITMENTS');
    expect(r.eacCents).toBe(800_000);
    expect(r.costToCompleteCents).toBe(400_000);
  });
  it('final margin equals original margin (no fade)', () => {
    expect(r.estimatedFinalMarginCents).toBe(200_000);
    expect(r.estimatedFinalMarginPct).toBe(20.0);
    expect(r.originalMarginPct).toBe(20.0);
    expect(r.varianceVsBudgetCents).toBe(0);
    expect(r.marginFadeBps).toBe(0);
    expect(r.projectedLoss).toBe(false);
    expect(r.marginFade).toBe(false);
  });
  it('reports cost-to-cost %-complete', () => {
    expect(r.costPctComplete).toBe(0.5);
    expect(r.pctCompleteDisplay).toBe(50.0);
  });
});

describe('computeEac — commitments push past budget (margin fade)', () => {
  const r = computeEac({
    contractValueCents: 1_000_000,
    originalBudgetCents: 800_000,
    budgetCents: 800_000,
    costsToDateCents: 700_000,
    committedOpenCents: 250_000, // floor = 950,000 > 800,000 budget
  });
  it('EAC floors at costs + open commitments', () => {
    expect(r.eacCents).toBe(950_000);
    expect(r.costToCompleteCents).toBe(250_000);
    expect(r.varianceVsBudgetCents).toBe(150_000);
  });
  it('flags margin fade but not a loss', () => {
    expect(r.estimatedFinalMarginCents).toBe(50_000);
    expect(r.estimatedFinalMarginPct).toBe(5.0);
    expect(r.marginFadeBps).toBe(1500); // (20.0 − 5.0) pts × 100
    expect(r.marginFade).toBe(true);
    expect(r.projectedLoss).toBe(false);
  });
});

describe('computeEac — PROGRESS (CPI) reveals a projected loss', () => {
  const r = computeEac(
    {
      contractValueCents: 1_000_000,
      originalBudgetCents: 850_000,
      budgetCents: 850_000,
      costsToDateCents: 700_000,
      committedOpenCents: 0,
      progressPctComplete: 0.6, // physically 60% done but 82% of budget spent
    },
    { method: 'PROGRESS' },
  );
  it('projects EAC = costs ÷ physical %-complete', () => {
    expect(r.eacCents).toBe(1_166_667); // round(700000 / 0.6)
    expect(r.pctComplete).toBe(0.6);
    expect(r.costToCompleteCents).toBe(466_667);
  });
  it('flags the loss and the fade', () => {
    expect(r.estimatedFinalMarginCents).toBe(-166_667);
    expect(r.estimatedFinalMarginPct).toBe(-16.7);
    expect(r.projectedLoss).toBe(true);
    expect(r.marginFade).toBe(true);
    expect(r.marginFadeBps).toBe(3170); // (15.0 − (−16.7)) × 100
  });
});

describe('computeEac — method contrast on the same job', () => {
  const input: EacInput = {
    contractValueCents: 500_000,
    originalBudgetCents: 400_000,
    budgetCents: 400_000,
    costsToDateCents: 100_000,
    committedOpenCents: 350_000, // floor 450,000 > 400,000 budget
  };
  it('COST_TO_COST ignores open commitments', () => {
    const r = computeEac(input, { method: 'COST_TO_COST' });
    expect(r.eacCents).toBe(400_000);
    expect(r.estimatedFinalMarginCents).toBe(100_000);
    expect(r.marginFade).toBe(false);
  });
  it('COMMITMENTS pulls the overrun forward', () => {
    const r = computeEac(input, { method: 'COMMITMENTS' });
    expect(r.eacCents).toBe(450_000);
    expect(r.estimatedFinalMarginCents).toBe(50_000);
    expect(r.estimatedFinalMarginPct).toBe(10.0);
    expect(r.marginFadeBps).toBe(1000);
    expect(r.marginFade).toBe(true);
  });
});

describe('computeEac — degenerate contract value', () => {
  const r = computeEac({
    contractValueCents: 0,
    originalBudgetCents: 0,
    budgetCents: 0,
    costsToDateCents: 50_000,
    committedOpenCents: 0,
  });
  it('has null margin % but still flags a loss on cost with no revenue', () => {
    expect(r.eacCents).toBe(50_000);
    expect(r.estimatedFinalMarginCents).toBe(-50_000);
    expect(r.estimatedFinalMarginPct).toBeNull();
    expect(r.projectedLoss).toBe(true);
    expect(r.marginFade).toBe(false); // undefined margin % → no fade signal
  });
});

describe('rollupEac — portfolio', () => {
  const results: EacResult[] = [
    computeEac(HEALTHY),
    computeEac({
      contractValueCents: 1_000_000,
      originalBudgetCents: 800_000,
      budgetCents: 800_000,
      costsToDateCents: 700_000,
      committedOpenCents: 250_000,
    }),
    computeEac(
      {
        contractValueCents: 1_000_000,
        originalBudgetCents: 850_000,
        budgetCents: 850_000,
        costsToDateCents: 700_000,
        committedOpenCents: 0,
        progressPctComplete: 0.6,
      },
      { method: 'PROGRESS' },
    ),
  ];
  const t = rollupEac(results);
  it('sums contract, EAC, and margin', () => {
    expect(t.jobs).toBe(3);
    expect(t.contractValueCents).toBe(3_000_000);
    expect(t.eacCents).toBe(2_916_667);
    expect(t.estimatedFinalMarginCents).toBe(83_333);
    expect(t.estimatedFinalMarginPct).toBe(2.8);
  });
  it('counts at-risk jobs and loss exposure', () => {
    expect(t.projectedLossJobs).toBe(1);
    expect(t.marginFadeJobs).toBe(2);
    expect(t.projectedLossExposureCents).toBe(166_667);
  });
});
