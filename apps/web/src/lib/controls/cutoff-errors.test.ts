/**
 * EC-12 period cut-off logic. Pins the period/date math, the memo economic-date
 * extractor, own-boundary proximity, the economic-date-vs-posted-period comparison
 * (direction, span bounds, boundary-window gating, confidence), the tiering
 * (REVIEW by default; ESCALATE across a closed period or on a very large shift), and
 * the dedup-key stability (idempotency contract). Pure logic only — no Supabase, no
 * wall-clock.
 */

import { describe, it, expect } from 'vitest';
import {
  periodOf,
  periodToIndex,
  indexToPeriod,
  previousPeriod,
  lastDayOfPeriodISO,
  daysBetween,
  toConfidence,
  dedupKey,
  extractMemoDate,
  nearOwnBoundary,
  assessCutoff,
  resolveCutoffTier,
  CUTOFF_THRESHOLDS,
} from './cutoff-errors';
import type { TierPolicy } from '@/lib/trust/score-tier';

const POLICY: TierPolicy = { autoThreshold: 0.85, reviewThreshold: 0.7, autoMaxCents: 1_000_000 };

// ── period + date math ─────────────────────────────────────────────────────────
describe('period + date math', () => {
  it('periodOf buckets a date to YYYY-MM (or null)', () => {
    expect(periodOf('2025-12-31')).toBe('2025-12');
    expect(periodOf('2026-01-02T09:00:00Z')).toBe('2026-01');
    expect(periodOf(null)).toBeNull();
    expect(periodOf('not-a-date')).toBeNull();
  });

  it('periodToIndex / indexToPeriod round-trip and reject malformed', () => {
    const idx = periodToIndex('2026-01');
    expect(idx).not.toBeNull();
    expect(indexToPeriod(idx!)).toBe('2026-01');
    expect(periodToIndex('2026-13')).toBeNull();
    expect(periodToIndex('2026-1')).toBeNull();
  });

  it('previousPeriod crosses the year boundary', () => {
    expect(previousPeriod('2026-01')).toBe('2025-12');
    expect(previousPeriod('2026-03')).toBe('2026-02');
  });

  it('lastDayOfPeriodISO handles month lengths and leap Feb', () => {
    expect(lastDayOfPeriodISO('2025-12')).toBe('2025-12-31');
    expect(lastDayOfPeriodISO('2026-02')).toBe('2026-02-28');
    expect(lastDayOfPeriodISO('2024-02')).toBe('2024-02-29'); // leap
    expect(lastDayOfPeriodISO('2026-04')).toBe('2026-04-30');
  });

  it('daysBetween is a signed whole-day difference across the year boundary', () => {
    expect(daysBetween('2026-01-02', '2025-12-31')).toBe(2);
    expect(daysBetween('2025-12-31', '2026-01-02')).toBe(-2);
    expect(daysBetween('2026-01-01', '2026-01-01')).toBe(0);
    expect(daysBetween('bad', '2026-01-01')).toBeNull();
  });

  it('toConfidence clamps into the numeric(5,4) range', () => {
    expect(toConfidence(1.5)).toBe(0.9999);
    expect(toConfidence(-1)).toBe(0);
    expect(toConfidence(0.78123)).toBe(0.7812);
  });

  it('dedupKey is stable and gl-entry-scoped', () => {
    expect(dedupKey('abc')).toBe('cutoff:abc');
  });
});

// ── memo economic-date extraction ───────────────────────────────────────────────
describe('extractMemoDate', () => {
  it('reads an ISO date', () => {
    expect(extractMemoDate('Consulting through 2025-12-31 per SOW')).toBe('2025-12-31');
  });
  it('reads US numeric full and month/year', () => {
    expect(extractMemoDate('Service 12/28/2025')).toBe('2025-12-28');
    expect(extractMemoDate('Rent 01/2026')).toBe('2026-01-01');
  });
  it('reads a month name + year to the first of month', () => {
    expect(extractMemoDate('December 2025 utilities')).toBe('2025-12-01');
    expect(extractMemoDate('accrual for Dec 2025')).toBe('2025-12-01');
  });
  it('returns null when there is no date or it is out of range', () => {
    expect(extractMemoDate('monthly close entry')).toBeNull();
    expect(extractMemoDate(null)).toBeNull();
    expect(extractMemoDate('13/40/2025')).toBeNull();
  });
});

// ── own-boundary proximity (signal B gate) ──────────────────────────────────────
describe('nearOwnBoundary', () => {
  it('flags the last days of the month (end side)', () => {
    const p = nearOwnBoundary('2025-12-30', 5);
    expect(p.near).toBe(true);
    expect(p.side).toBe('end');
    expect(p.days).toBe(1);
  });
  it('flags the first days of the month (start side)', () => {
    const p = nearOwnBoundary('2026-01-02', 5);
    expect(p.near).toBe(true);
    expect(p.side).toBe('start');
    expect(p.days).toBe(1);
  });
  it('does not flag mid-month', () => {
    expect(nearOwnBoundary('2026-01-15', 5).near).toBe(false);
  });
});

// ── the core: economic-date vs posted-period comparison ─────────────────────────
describe('assessCutoff', () => {
  it('flags a December-dated invoice posted in January as recognized LATE', () => {
    const a = assessCutoff({
      economicDateISO: '2025-12-31',
      postedDateISO: '2026-01-03',
      amountAtRiskCents: 4_000_000,
      evidence: 'document',
    });
    expect(a).not.toBeNull();
    expect(a!.direction).toBe('late');
    expect(a!.economicPeriod).toBe('2025-12');
    expect(a!.postedPeriod).toBe('2026-01');
    expect(a!.spanMonths).toBe(1);
    expect(a!.daysFromCut).toBe(0); // economic date IS the cut (Dec 31)
    // documentary + tight window ⇒ high, but capped at the ceiling
    expect(a!.confidence).toBeCloseTo(CUTOFF_THRESHOLDS.confidenceCeil, 5);
  });

  it('flags a next-period bill expensed early as recognized EARLY', () => {
    const a = assessCutoff({
      economicDateISO: '2026-01-02',
      postedDateISO: '2025-12-30',
      amountAtRiskCents: 900_000,
      evidence: 'document',
    });
    expect(a).not.toBeNull();
    expect(a!.direction).toBe('early');
    expect(a!.economicPeriod).toBe('2026-01');
    expect(a!.postedPeriod).toBe('2025-12');
  });

  it('returns null when both dates are in the same period', () => {
    expect(
      assessCutoff({
        economicDateISO: '2026-01-05',
        postedDateISO: '2026-01-20',
        amountAtRiskCents: 5_000_000,
        evidence: 'document',
      }),
    ).toBeNull();
  });

  it('returns null when the mismatch spans more than the max (a late entry, not a cut-off)', () => {
    // Oct economic vs Jan posted = span 3 > maxSpanMonths(1)
    expect(
      assessCutoff({
        economicDateISO: '2025-10-15',
        postedDateISO: '2026-01-10',
        amountAtRiskCents: 5_000_000,
        evidence: 'document',
      }),
    ).toBeNull();
  });

  it('returns null when neither date is near the cut (a plain reclass, not a cut-off)', () => {
    // Adjacent periods but both dates far from the Dec 31 cut.
    expect(
      assessCutoff({
        economicDateISO: '2025-12-05',
        postedDateISO: '2026-01-25',
        amountAtRiskCents: 5_000_000,
        evidence: 'document',
      }),
    ).toBeNull();
  });

  it('memo-derived evidence yields lower confidence than a linked document', () => {
    const base = {
      economicDateISO: '2025-12-29',
      postedDateISO: '2026-01-04',
      amountAtRiskCents: 3_000_000,
    };
    const doc = assessCutoff({ ...base, evidence: 'document' });
    const memo = assessCutoff({ ...base, evidence: 'memo' });
    expect(doc!.confidence).toBeGreaterThan(memo!.confidence);
  });
});

// ── tiering ─────────────────────────────────────────────────────────────────────
describe('resolveCutoffTier', () => {
  it('is REVIEW for a normal-size cut-off in open periods', () => {
    expect(resolveCutoffTier(4_000_000, false, 0.85, POLICY)).toBe('review');
  });

  it('ESCALATES when the correction crosses a CLOSED/LOCKED period', () => {
    expect(resolveCutoffTier(500_000, true, 0.9, POLICY)).toBe('escalate');
  });

  it('ESCALATES on a very large shift regardless of period status', () => {
    expect(
      resolveCutoffTier(CUTOFF_THRESHOLDS.escalateAtRiskCents, false, 0.9, POLICY),
    ).toBe('escalate');
  });

  it('never returns auto — a detection is never auto-applied', () => {
    // high confidence + small amount would be "auto" for an autonomous action;
    // a control downgrades it to review.
    expect(resolveCutoffTier(1_000, false, 0.99, POLICY)).toBe('review');
  });

  it('keeps a bare signal-B proximity flag at REVIEW (proximityConfidence == review cut-line)', () => {
    expect(
      resolveCutoffTier(3_000_000, false, CUTOFF_THRESHOLDS.proximityConfidence, POLICY),
    ).toBe('review');
  });

  it('ESCALATES a genuinely sub-review confidence (below the policy review threshold)', () => {
    expect(resolveCutoffTier(3_000_000, false, 0.55, POLICY)).toBe('escalate');
  });
});
