/**
 * EC-2 missed-accrual recurrence / estimate logic. Pins the period math, cadence
 * detection, gap classification (interior vs trailing vs churned), the run-rate
 * estimate, the confidence formula, tiering, the configured-recurrence (template /
 * schedule) due checks, and the dedup-key stability (idempotency contract). Pure
 * logic only — no Supabase, no wall-clock.
 */

import { describe, it, expect } from 'vitest';
import {
  periodOf,
  periodToIndex,
  indexToPeriod,
  addPeriods,
  previousPeriod,
  toConfidence,
  dedupKey,
  detectCadence,
  classifyGap,
  estimateAccrual,
  accrualConfidence,
  assessVendorRecurrence,
  templateDueForPeriod,
  scheduleDueForPeriod,
  resolveAccrualTier,
  ACCRUAL_THRESHOLDS,
  type VendorBill,
  type RecurringTemplateRow,
  type PostingScheduleRow,
} from './missed-accruals';
import type { TierPolicy } from '@/lib/trust/score-tier';

const POLICY: TierPolicy = { autoThreshold: 0.85, reviewThreshold: 0.7, autoMaxCents: 1_000_000 };

// ── period math ───────────────────────────────────────────────────────────────
describe('period math', () => {
  it('periodOf buckets a date to YYYY-MM (or null)', () => {
    expect(periodOf('2026-03-17')).toBe('2026-03');
    expect(periodOf('2026-03-17T12:00:00Z')).toBe('2026-03');
    expect(periodOf(null)).toBeNull();
    expect(periodOf('not-a-date')).toBeNull();
  });
  it('periodToIndex / indexToPeriod round-trip', () => {
    const idx = periodToIndex('2026-03')!;
    expect(indexToPeriod(idx)).toBe('2026-03');
    expect(periodToIndex('2026-13')).toBeNull();
    expect(periodToIndex('bad')).toBeNull();
  });
  it('addPeriods crosses year boundaries', () => {
    expect(addPeriods('2026-01', -1)).toBe('2025-12');
    expect(addPeriods('2026-11', 3)).toBe('2027-02');
    expect(previousPeriod('2026-03')).toBe('2026-02');
  });
});

describe('toConfidence', () => {
  it('clamps into numeric(5,4)', () => {
    expect(toConfidence(0.9)).toBe(0.9);
    expect(toConfidence(1)).toBe(0.9999);
    expect(toConfidence(NaN)).toBe(0);
  });
});

describe('dedupKey', () => {
  it('is stable and includes kind + subject + period (idempotency key)', () => {
    expect(dedupKey('vendor_recurrence', 'v1', '2026-03')).toBe('accrual:vendor_recurrence:v1:2026-03');
    expect(dedupKey('recurring_template', 't1', '2026-03')).toBe('accrual:recurring_template:t1:2026-03');
  });
});

// ── cadence detection ───────────────────────────────────────────────────────
describe('detectCadence', () => {
  const idx = (p: string) => periodToIndex(p)!;
  it('detects a monthly cadence from regular history', () => {
    const c = detectCadence(['2026-01', '2026-02', '2026-03', '2026-04'].map(idx));
    expect(c).not.toBeNull();
    expect(c!.intervalMonths).toBe(1);
    expect(c!.regularity).toBe(1);
    expect(c!.occurrences).toBe(4);
  });
  it('detects a quarterly cadence', () => {
    const c = detectCadence(['2025-06', '2025-09', '2025-12', '2026-03'].map(idx));
    expect(c!.intervalMonths).toBe(3);
  });
  it('returns null for too-few occurrences', () => {
    expect(detectCadence(['2026-01', '2026-02'].map(idx))).toBeNull();
  });
  it('returns null for irregular / sparse history (anti-cry-wolf)', () => {
    // one-offs spread far apart → not recurring
    expect(detectCadence(['2024-01', '2025-04', '2026-02'].map(idx))).toBeNull();
  });
  it('tolerates a single skipped month and still reads monthly', () => {
    // Jan, Feb, (skip Mar), Apr, May → intervals [1,2,1] → modal 1, regularity 2/3
    const c = detectCadence(['2026-01', '2026-02', '2026-04', '2026-05'].map(idx));
    expect(c).not.toBeNull();
    expect(c!.intervalMonths).toBe(1);
    expect(c!.regularity).toBeCloseTo(2 / 3, 5);
  });
});

// ── gap classification ────────────────────────────────────────────────────────
describe('classifyGap', () => {
  const idx = (p: string) => periodToIndex(p)!;
  it('interior: billed before AND after the empty target', () => {
    const billed = ['2026-01', '2026-02', '2026-04', '2026-05'].map(idx);
    expect(classifyGap(billed, idx('2026-03'), 1)).toBe('interior');
  });
  it('trailing: target is the immediate next expected period after the last bill', () => {
    const billed = ['2026-01', '2026-02', '2026-03'].map(idx);
    expect(classifyGap(billed, idx('2026-04'), 1)).toBe('trailing');
  });
  it('none: target already billed', () => {
    const billed = ['2026-01', '2026-02', '2026-03'].map(idx);
    expect(classifyGap(billed, idx('2026-02'), 1)).toBe('none');
  });
  it('none: target far past the last bill (vendor likely churned — fail quiet)', () => {
    const billed = ['2026-01', '2026-02', '2026-03'].map(idx);
    expect(classifyGap(billed, idx('2026-09'), 1)).toBe('none');
  });
});

// ── estimate ──────────────────────────────────────────────────────────────────
describe('estimateAccrual', () => {
  it('is the mean of the most recent window', () => {
    const est = estimateAccrual([100_000, 100_000, 100_000], 3);
    expect(est.estimateCents).toBe(100_000);
    expect(est.cv).toBe(0);
  });
  it('uses only the last `window` periods and returns a range', () => {
    const est = estimateAccrual([10_000, 200_000, 300_000, 400_000], 3);
    // mean of last 3 = (200k+300k+400k)/3 = 300k
    expect(est.estimateCents).toBe(300_000);
    expect(est.low).toBe(200_000);
    expect(est.high).toBe(400_000);
    expect(est.cv).toBeGreaterThan(0);
  });
  it('sign-normalizes and handles an empty window', () => {
    expect(estimateAccrual([-50_000], 3).estimateCents).toBe(50_000);
    expect(estimateAccrual([], 3).estimateCents).toBe(0);
  });
});

// ── confidence ────────────────────────────────────────────────────────────────
describe('accrualConfidence', () => {
  it('sits at the floor for a barely-regular, thin, volatile trailing gap', () => {
    const c = accrualConfidence({ regularity: ACCRUAL_THRESHOLDS.minRegularity, occurrences: 3, cv: 1, gapType: 'trailing' });
    expect(c).toBeCloseTo(ACCRUAL_THRESHOLDS.confidenceFloor + (Math.min(3, 6) / 6) * 0.1, 5);
  });
  it('rises with regularity, depth, stability, and an interior gap; caps at the ceiling', () => {
    const strong = accrualConfidence({ regularity: 1, occurrences: 12, cv: 0, gapType: 'interior' });
    const weak = accrualConfidence({ regularity: 0.6, occurrences: 3, cv: 1, gapType: 'trailing' });
    expect(strong).toBeGreaterThan(weak);
    expect(strong).toBeLessThanOrEqual(ACCRUAL_THRESHOLDS.confidenceCeil);
    // interior beats an otherwise-identical trailing gap
    const interior = accrualConfidence({ regularity: 0.9, occurrences: 6, cv: 0.1, gapType: 'interior' });
    const trailing = accrualConfidence({ regularity: 0.9, occurrences: 6, cv: 0.1, gapType: 'trailing' });
    expect(interior).toBeGreaterThan(trailing);
  });
});

// ── end-to-end vendor assessment ──────────────────────────────────────────────
function bills(periods: string[], amount = 420_000): VendorBill[] {
  return periods.map((p) => ({ period: p, amountCents: amount }));
}

describe('assessVendorRecurrence', () => {
  it('flags a trailing gap for a monthly vendor that went silent this period', () => {
    const a = assessVendorRecurrence(bills(['2025-11', '2025-12', '2026-01', '2026-02']), '2026-03');
    expect(a).not.toBeNull();
    expect(a!.gapType).toBe('trailing');
    expect(a!.intervalMonths).toBe(1);
    expect(a!.estimateCents).toBe(420_000);
    expect(a!.confidence).toBeGreaterThanOrEqual(ACCRUAL_THRESHOLDS.confidenceFloor);
  });
  it('flags an interior gap (skipped month) with higher confidence than a trailing one', () => {
    const interior = assessVendorRecurrence(
      bills(['2026-01', '2026-02', '2026-04', '2026-05']),
      '2026-03',
    );
    expect(interior).not.toBeNull();
    expect(interior!.gapType).toBe('interior');
  });
  it('returns null when the vendor already billed the target period', () => {
    expect(assessVendorRecurrence(bills(['2026-01', '2026-02', '2026-03']), '2026-03')).toBeNull();
  });
  it('returns null for a non-recurring / occasional vendor', () => {
    expect(assessVendorRecurrence(bills(['2024-01', '2025-06']), '2026-03')).toBeNull();
  });
  it('run-rate estimate follows the recent amounts, not the old ones', () => {
    const a = assessVendorRecurrence(
      [
        { period: '2025-11', amountCents: 100_000 },
        { period: '2025-12', amountCents: 500_000 },
        { period: '2026-01', amountCents: 500_000 },
        { period: '2026-02', amountCents: 500_000 },
      ],
      '2026-03',
    );
    // mean of last 3 = 500k (the 100k Nov falls out of the window)
    expect(a!.estimateCents).toBe(500_000);
  });
  it('sums multiple bills in the same period into one run-rate', () => {
    const a = assessVendorRecurrence(
      [
        { period: '2025-12', amountCents: 200_000 },
        { period: '2025-12', amountCents: 100_000 }, // same month → summed to 300k
        { period: '2026-01', amountCents: 300_000 },
        { period: '2026-02', amountCents: 300_000 },
      ],
      '2026-03',
    );
    expect(a).not.toBeNull();
    expect(a!.estimateCents).toBe(300_000);
  });
});

// ── tiering ───────────────────────────────────────────────────────────────────
describe('resolveAccrualTier', () => {
  it('reviews a normal-sized accrual (EC-2 is a REVIEW control — never auto)', () => {
    expect(resolveAccrualTier(420_000, 0.95, POLICY)).toBe('review');
  });
  it('escalates a very large (six-figure) missed accrual — covenant risk', () => {
    expect(resolveAccrualTier(ACCRUAL_THRESHOLDS.escalateAtRiskCents, 0.9, POLICY)).toBe('escalate');
  });
  it('escalates below the review confidence line', () => {
    expect(resolveAccrualTier(420_000, 0.5, POLICY)).toBe('escalate');
  });
});

// ── configured recurrence: templates ──────────────────────────────────────────
function tpl(over: Partial<RecurringTemplateRow>): RecurringTemplateRow {
  return {
    frequency: 'MONTHLY',
    start_date: '2025-06-01',
    end_date: null,
    is_active: true,
    last_generated_at: '2026-02-15',
    ...over,
  };
}

describe('templateDueForPeriod', () => {
  it('is due when a monthly template was last generated before the target', () => {
    expect(templateDueForPeriod(tpl({ last_generated_at: '2026-02-10' }), '2026-03')).toBe(true);
  });
  it('is not due when already generated in the target period', () => {
    expect(templateDueForPeriod(tpl({ last_generated_at: '2026-03-02' }), '2026-03')).toBe(false);
  });
  it('respects quarterly alignment relative to start', () => {
    const q = tpl({ frequency: 'QUARTERLY', start_date: '2025-06-01', last_generated_at: null });
    expect(templateDueForPeriod(q, '2025-09')).toBe(true); // +3 months → aligned
    expect(templateDueForPeriod(q, '2025-08')).toBe(false); // not on the quarter
  });
  it('is not due before start, after end, or when inactive', () => {
    expect(templateDueForPeriod(tpl({ start_date: '2026-05-01' }), '2026-03')).toBe(false);
    expect(templateDueForPeriod(tpl({ end_date: '2026-01-31' }), '2026-03')).toBe(false);
    expect(templateDueForPeriod(tpl({ is_active: false }), '2026-03')).toBe(false);
  });
  it('is due when never generated', () => {
    expect(templateDueForPeriod(tpl({ last_generated_at: null }), '2026-03')).toBe(true);
  });
});

// ── configured recurrence: posting schedules ──────────────────────────────────
function sch(over: Partial<PostingScheduleRow>): PostingScheduleRow {
  return { status: 'ACTIVE', start_date: '2025-10-01', months: 12, ...over };
}

describe('scheduleDueForPeriod', () => {
  it('is due when within span and no run exists', () => {
    expect(scheduleDueForPeriod(sch({}), '2026-03', false)).toBe(true);
  });
  it('is not due when a run already exists for the period', () => {
    expect(scheduleDueForPeriod(sch({}), '2026-03', false)).toBe(true);
    expect(scheduleDueForPeriod(sch({}), '2026-03', true)).toBe(false);
  });
  it('is not due before start, past the end of the span, or when not active', () => {
    expect(scheduleDueForPeriod(sch({ start_date: '2026-06-01' }), '2026-03', false)).toBe(false);
    // start 2025-10 + 12 months → last period 2026-09; 2026-11 is past the span
    expect(scheduleDueForPeriod(sch({}), '2026-11', false)).toBe(false);
    expect(scheduleDueForPeriod(sch({ status: 'CANCELLED' }), '2026-03', false)).toBe(false);
  });
});
