/**
 * EC-6 revenue-not-recognized logic. Pins the period math, the earned-vs-recognized
 * gap, materiality (absolute floor vs fraction-of-contract), the POC confidence
 * formula, the schedule-run due check, tiering (REVIEW baseline; ESCALATE on a
 * closing/closed period, a large amount, or a completed-job misstatement), the
 * method-inputs guard, and the dedup-key stability (idempotency contract). Also
 * proves the earned-to-date figure is the rev-rec ENGINE's math (not re-implemented).
 * Pure logic only — no Supabase, no wall-clock.
 */

import { describe, it, expect } from 'vitest';
import {
  periodOf,
  periodToIndex,
  indexToPeriod,
  addPeriods,
  previousPeriod,
  periodEndDate,
  toConfidence,
  dedupKey,
  earnedRecognizedGap,
  isMaterial,
  pocConfidence,
  scheduleRunDueForPeriod,
  resolveRevRecTier,
  methodHasInputs,
  REVREC_THRESHOLDS,
  type DeferredScheduleRow,
} from './revenue-not-recognized';
import { earnedToDate, type JobRevRecRow } from '@/lib/services/rev-rec';
import type { TierPolicy } from '@/lib/trust/score-tier';

const POLICY: TierPolicy = { autoThreshold: 0.85, reviewThreshold: 0.7, autoMaxCents: 1_000_000 };

// ── period math ───────────────────────────────────────────────────────────────
describe('period math', () => {
  it('periodOf buckets a date to YYYY-MM (or null)', () => {
    expect(periodOf('2026-03-17')).toBe('2026-03');
    expect(periodOf('2026-03-17T12:00:00Z')).toBe('2026-03');
    expect(periodOf(null)).toBeNull();
    expect(periodOf('nope')).toBeNull();
  });
  it('periodToIndex / indexToPeriod round-trip; addPeriods / previousPeriod', () => {
    const idx = periodToIndex('2026-03')!;
    expect(indexToPeriod(idx)).toBe('2026-03');
    expect(periodToIndex('2026-13')).toBeNull();
    expect(addPeriods('2026-01', -1)).toBe('2025-12');
    expect(previousPeriod('2026-08')).toBe('2026-07');
  });
  it('periodEndDate returns the last calendar day (leap-aware)', () => {
    expect(periodEndDate('2026-08')).toBe('2026-08-31');
    expect(periodEndDate('2026-02')).toBe('2026-02-28');
    expect(periodEndDate('2024-02')).toBe('2024-02-29');
    expect(periodEndDate('2026-04')).toBe('2026-04-30');
    expect(periodEndDate('bad')).toBeNull();
  });
});

// ── toConfidence + dedupKey ─────────────────────────────────────────────────────
describe('confidence clamp + dedup key', () => {
  it('toConfidence clamps into numeric(5,4) range', () => {
    expect(toConfidence(1.5)).toBe(0.9999);
    expect(toConfidence(-1)).toBe(0);
    expect(toConfidence(0.87654321)).toBe(0.8765);
  });
  it('dedupKey is stable + kind/subject/period addressable', () => {
    expect(dedupKey('schedule', 's1', '2026-07')).toBe('revrec:schedule:s1:2026-07');
    expect(dedupKey('job_progress', 'j1', '2026-07')).toBe('revrec:job_progress:j1:2026-07');
    expect(dedupKey('completed_job', 'j2', '2026-07')).toBe('revrec:completed_job:j2:2026-07');
    // stability across calls (idempotency contract)
    expect(dedupKey('schedule', 's1', '2026-07')).toBe(dedupKey('schedule', 's1', '2026-07'));
  });
});

// ── earned-vs-recognized gap ────────────────────────────────────────────────────
describe('earnedRecognizedGap', () => {
  it('is the positive earned-minus-recognized delta', () => {
    expect(earnedRecognizedGap(1_000_000, 400_000)).toBe(600_000);
  });
  it('never negative — over-recognition is a different exception class', () => {
    expect(earnedRecognizedGap(400_000, 1_000_000)).toBe(0);
    expect(earnedRecognizedGap(500_000, 500_000)).toBe(0);
  });
  it('coerces non-finite inputs to 0', () => {
    expect(earnedRecognizedGap(NaN as unknown as number, 0)).toBe(0);
  });
});

// ── materiality: max(absolute floor, fraction-of-contract) ──────────────────────
describe('isMaterial', () => {
  it('below the absolute floor is not material', () => {
    // floor is $1,000 = 100_000 cents; a small contract uses the floor
    expect(isMaterial(50_000, 1_000_000)).toBe(false); // $500 gap on a $10k contract
    expect(isMaterial(150_000, 1_000_000)).toBe(true); // $1,500 gap → material
  });
  it('scales with the contract — 1% of a huge contract dominates the floor', () => {
    // 1% of $10,000,000 = $100,000 = 10_000_000 cents
    expect(isMaterial(5_000_000, 1_000_000_000)).toBe(false); // $50k < 1% threshold
    expect(isMaterial(12_000_000, 1_000_000_000)).toBe(true); // $120k ≥ 1% threshold
  });
  it('non-positive gap is never material', () => {
    expect(isMaterial(0, 1_000_000)).toBe(false);
    expect(isMaterial(-100, 1_000_000)).toBe(false);
  });
});

// ── POC confidence ──────────────────────────────────────────────────────────────
describe('pocConfidence', () => {
  it('returns 0 when the method drivers are missing (caller should skip)', () => {
    expect(pocConfidence({ underCents: 500_000, contractCents: 1_000_000, hasInputs: false })).toBe(0);
  });
  it('sits within [floor, ceil] and rises with a larger relative gap', () => {
    const small = pocConfidence({ underCents: 10_000, contractCents: 10_000_000, hasInputs: true });
    const big = pocConfidence({ underCents: 3_000_000, contractCents: 10_000_000, hasInputs: true });
    expect(small).toBeGreaterThanOrEqual(REVREC_THRESHOLDS.pocFloor);
    expect(big).toBeLessThanOrEqual(REVREC_THRESHOLDS.pocCeil);
    expect(big).toBeGreaterThan(small);
  });
  it('a gap ≥20% of contract reaches the ceiling', () => {
    expect(pocConfidence({ underCents: 2_500_000, contractCents: 10_000_000, hasInputs: true })).toBe(
      REVREC_THRESHOLDS.pocCeil,
    );
  });
});

// ── schedule-run due check ──────────────────────────────────────────────────────
describe('scheduleRunDueForPeriod', () => {
  const sch: DeferredScheduleRow = { status: 'ACTIVE', start_date: '2026-01-15', months: 12 };
  it('due when in-window and no run recorded', () => {
    expect(scheduleRunDueForPeriod(sch, '2026-07', false)).toBe(true);
  });
  it('not due when a run already exists for the period', () => {
    expect(scheduleRunDueForPeriod(sch, '2026-07', false)).toBe(true);
    expect(scheduleRunDueForPeriod(sch, '2026-07', true)).toBe(false);
  });
  it('not due before start or after the schedule ends', () => {
    expect(scheduleRunDueForPeriod(sch, '2025-12', false)).toBe(false); // before start
    expect(scheduleRunDueForPeriod(sch, '2027-02', false)).toBe(false); // past start+11
  });
  it('inactive / zero-month schedules never trip', () => {
    expect(scheduleRunDueForPeriod({ ...sch, status: 'CANCELLED' }, '2026-07', false)).toBe(false);
    expect(scheduleRunDueForPeriod({ ...sch, months: 0 }, '2026-07', false)).toBe(false);
  });
});

// ── method-inputs guard ─────────────────────────────────────────────────────────
describe('methodHasInputs', () => {
  const base = { contract_amount_cents: 1_000_000, estimated_cost_cents: 0, pct_complete: null, service_start_date: null, service_end_date: null };
  it('PCT_COSTS_INCURRED requires a positive cost estimate', () => {
    expect(methodHasInputs('PCT_COSTS_INCURRED', { ...base, estimated_cost_cents: 0 })).toBe(false);
    expect(methodHasInputs('PCT_COSTS_INCURRED', { ...base, estimated_cost_cents: 800_000 })).toBe(true);
  });
  it('PCT_COMPLETE requires a positive pct_complete', () => {
    expect(methodHasInputs('PCT_COMPLETE', { ...base, pct_complete: 0 })).toBe(false);
    expect(methodHasInputs('PCT_COMPLETE', { ...base, pct_complete: 40 })).toBe(true);
  });
  it('RATABLY/SUBSCRIPTION require a service window', () => {
    expect(methodHasInputs('RATABLY', base)).toBe(false);
    expect(methodHasInputs('SUBSCRIPTION', { ...base, service_start_date: '2026-01-01', service_end_date: '2026-12-31' })).toBe(true);
  });
  it('a zero/negative contract is never usable', () => {
    expect(methodHasInputs('PCT_COMPLETE', { ...base, contract_amount_cents: 0, pct_complete: 50 })).toBe(false);
  });
});

// ── tiering ─────────────────────────────────────────────────────────────────────
describe('resolveRevRecTier', () => {
  it('a normal, confident, immaterial-ish gap in an OPEN period → REVIEW (never auto)', () => {
    expect(resolveRevRecTier(500_000, 0.9, POLICY, { periodStatus: 'OPEN' })).toBe('review');
  });
  it('a closing (SOFT_CLOSE) or closed (HARD_CLOSE) period → ESCALATE', () => {
    expect(resolveRevRecTier(500_000, 0.9, POLICY, { periodStatus: 'SOFT_CLOSE' })).toBe('escalate');
    expect(resolveRevRecTier(500_000, 0.9, POLICY, { periodStatus: 'HARD_CLOSE' })).toBe('escalate');
  });
  it('a very large amount → ESCALATE even in an OPEN period', () => {
    expect(resolveRevRecTier(REVREC_THRESHOLDS.escalateAtRiskCents, 0.9, POLICY, { periodStatus: 'OPEN' })).toBe('escalate');
  });
  it('forceEscalate (completed-job misstatement) always ESCALATEs', () => {
    expect(resolveRevRecTier(150_000, 0.88, POLICY, { periodStatus: 'OPEN', forceEscalate: true })).toBe('escalate');
  });
  it('low confidence → ESCALATE (below the review threshold)', () => {
    expect(resolveRevRecTier(150_000, 0.5, POLICY, { periodStatus: 'OPEN' })).toBe('escalate');
  });
});

// ── engine reuse: earned-to-date is the rev-rec ENGINE's math ───────────────────
describe('rev-rec engine reuse (earnedToDate) → gap', () => {
  const job = (over: Partial<JobRevRecRow>): JobRevRecRow => ({
    id: 'j1', location_id: 'loc1', job_type: null, archetype: null, status: 'ACTIVE',
    rev_rec_method: null, rev_rec_method_override: null, revenue_account_id: null,
    contract_amount_cents: 1_000_000, estimated_cost_cents: 800_000, actual_cost_cents: 400_000,
    billed_to_date_cents: 0, pct_complete: null, revenue_recognized_cents: 200_000,
    service_start_date: null, service_end_date: null, ...over,
  });

  it('PCT_COSTS_INCURRED: 50% cost-to-cost earns 50% of contract; gap = earned − recognized', () => {
    const j = job({}); // actual 400k / estimate 800k = 50% → earned 500k
    const { earnedCents, fraction } = earnedToDate('PCT_COSTS_INCURRED', j, '2026-08-31', 0);
    expect(fraction).toBe(0.5);
    expect(earnedCents).toBe(500_000);
    const under = earnedRecognizedGap(earnedCents, Number(j.revenue_recognized_cents));
    expect(under).toBe(300_000); // 500k earned − 200k recognized
    expect(isMaterial(under, Number(j.contract_amount_cents))).toBe(true);
  });

  it('PCT_COMPLETE: pct_complete drives the earned figure', () => {
    const j = job({ pct_complete: 40, revenue_recognized_cents: 100_000 });
    const { earnedCents } = earnedToDate('PCT_COMPLETE', j, '2026-08-31', 0);
    expect(earnedCents).toBe(400_000); // 40% of 1,000,000
    expect(earnedRecognizedGap(earnedCents, 100_000)).toBe(300_000);
  });

  it('fully recognized job shows no gap', () => {
    const j = job({ actual_cost_cents: 400_000, revenue_recognized_cents: 500_000 });
    const { earnedCents } = earnedToDate('PCT_COSTS_INCURRED', j, '2026-08-31', 0);
    expect(earnedRecognizedGap(earnedCents, Number(j.revenue_recognized_cents))).toBe(0);
  });
});
