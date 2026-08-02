import { describe, it, expect } from 'vitest';
import {
  computeBriefingFacts,
  deterministicNarrative,
  buildNarrativePrompt,
  compactMoney,
  type BriefingInputs,
} from './briefing';

/**
 * Fixed portfolio fixture — three jobs:
 *   J1  contract 1,000,000  proj final 1,150,000  → projected LOSS of 150,000
 *   J2  contract   500,000  proj final   470,000  → thin margin (8%)
 *   J3  contract 2,000,000  proj final 1,600,000  → healthy (20%)
 * Backlog = 3,500,000; projected final = 3,220,000; projected margin = 280,000 (8.0%).
 */
const inputs: BriefingInputs = {
  margins: [
    {
      job_id: 'J1',
      job_number: '1001',
      name: 'North Tower',
      revenue_contract_cents: 1_000_000,
      operational_actual_cents: 800_000,
      operational_pending_cents: 50_000,
      committed_open_cents: 100_000,
      projected_final_cents: 1_150_000,
      operational_margin_pct: -15,
    },
    {
      job_id: 'J2',
      job_number: '1002',
      name: 'Elm Renovation',
      revenue_contract_cents: 500_000,
      operational_actual_cents: 300_000,
      operational_pending_cents: 20_000,
      committed_open_cents: 40_000,
      projected_final_cents: 470_000,
      operational_margin_pct: 8,
    },
    {
      job_id: 'J3',
      job_number: '1003',
      name: 'Riverside Plant',
      // string cents (as bigint columns arrive over the wire)
      revenue_contract_cents: '2000000',
      operational_actual_cents: '1200000',
      operational_pending_cents: '0',
      committed_open_cents: '300000',
      projected_final_cents: '1600000',
      operational_margin_pct: 20,
    },
  ],
  slips: [
    { job_id: 'J1', variance_cents: -30_000 }, // over budget
    { job_id: 'J1', variance_cents: -10_000 }, // over budget (same job)
    { job_id: 'J2', variance_cents: 5_000 }, // under budget → ignored
    { job_id: 'J3', variance_cents: -80_000 }, // over budget
  ],
  gates: [
    { job_id: 'J1', name: 'Permit', gate_type: 'PERMIT', status: 'PENDING', blocks_billing: true },
    { job_id: 'J2', name: 'Inspection', gate_type: 'INSPECTION', status: 'CLEARED', blocks_billing: true }, // cleared → not open
    { job_id: 'J3', name: 'Survey', gate_type: 'SURVEY', status: 'PENDING', blocks_billing: false }, // open but not blocking
  ],
  draws: [
    { job_id: 'J1', status: 'DRAFT' }, // unissued
    { job_id: 'J3', status: 'ISSUED' }, // not draft → ignored
  ],
};

describe('computeBriefingFacts — totals', () => {
  const facts = computeBriefingFacts(inputs);

  it('sums contract backlog across all jobs (handles string cents)', () => {
    expect(facts.totals.contractBacklogCents).toBe(3_500_000);
  });
  it('sums projected final and derives projected margin', () => {
    expect(facts.totals.projectedFinalCents).toBe(3_220_000);
    expect(facts.totals.projectedMarginCents).toBe(280_000);
  });
  it('computes projected margin pct to one decimal', () => {
    expect(facts.totals.projectedMarginPct).toBe(8.0);
  });
  it('sums cost, committed and pending', () => {
    expect(facts.totals.costToDateCents).toBe(2_300_000);
    expect(facts.totals.committedOpenCents).toBe(440_000);
    expect(facts.totals.pendingCostCents).toBe(70_000);
  });
});

describe('computeBriefingFacts — counts', () => {
  const facts = computeBriefingFacts(inputs);

  it('counts jobs at projected loss', () => {
    expect(facts.counts.jobsAtProjectedLoss).toBe(1);
  });
  it('counts thin-margin jobs (below 12%, not already a loss)', () => {
    expect(facts.counts.thinMarginJobs).toBe(1);
  });
  it('counts only negative-variance cost codes', () => {
    expect(facts.counts.overBudgetCostCodes).toBe(3);
  });
  it('counts only open, billing-blocking gates', () => {
    expect(facts.counts.gatesBlockingBilling).toBe(1);
  });
  it('counts only DRAFT draws', () => {
    expect(facts.counts.unissuedDraws).toBe(1);
  });
  it('counts total jobs', () => {
    expect(facts.counts.jobs).toBe(3);
  });
});

describe('computeBriefingFacts — ranked attention', () => {
  const facts = computeBriefingFacts(inputs);

  it('returns at most the top 3', () => {
    expect(facts.attention).toHaveLength(3);
  });
  it('ranks the critical projected loss first with correct signed impact', () => {
    expect(facts.attention[0].kind).toBe('projected_loss');
    expect(facts.attention[0].severity).toBe('critical');
    expect(facts.attention[0].impactCents).toBe(-150_000);
    expect(facts.attention[0].href).toBe('/jobs/J1');
  });
  it('orders the two warnings by absolute dollar impact', () => {
    // J3 overrun (-80k) outranks J1 overrun (-40k); J2 thin margin (+30k) after.
    expect(facts.attention[1].kind).toBe('cost_overrun');
    expect(facts.attention[1].impactCents).toBe(-80_000);
    expect(facts.attention[2].severity).toBe('warning');
  });
});

describe('deterministicNarrative', () => {
  it('mentions the backlog, loss count, thin-margin and over-budget counts', () => {
    const text = deterministicNarrative(computeBriefingFacts(inputs));
    expect(text).toContain('3 jobs');
    expect(text).toContain('1 job is tracking to a projected loss');
    expect(text).toContain('below a 12% margin');
    expect(text).toContain('3 cost codes are over budget');
    expect(text).toContain('gate blocking billing');
    expect(text).toContain('draw ready to issue');
  });

  it('handles the empty portfolio with a friendly line', () => {
    const empty = computeBriefingFacts({ margins: [], slips: [], gates: [], draws: [] });
    expect(empty.counts.jobs).toBe(0);
    expect(empty.totals.projectedMarginPct).toBeNull();
    expect(deterministicNarrative(empty)).toContain('No active jobs');
  });
});

describe('helpers + prompt', () => {
  it('formats compact money with sign', () => {
    expect(compactMoney(3_500_000)).toBe('$35K');
    expect(compactMoney(-150_000)).toBe('-$2K');
    expect(compactMoney(120_000_000)).toBe('$1.2M');
  });
  it('buildNarrativePrompt embeds the computed figures and forbids altering them', () => {
    const prompt = buildNarrativePrompt(computeBriefingFacts(inputs));
    expect(prompt).toContain('do not alter or add any number');
    expect(prompt).toContain('Contracted backlog');
    expect(prompt).toContain('Cost codes over budget: 3');
  });
});
