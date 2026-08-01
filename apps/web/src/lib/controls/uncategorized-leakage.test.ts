/**
 * EC-4 uncategorized-leakage aging / aggregation / close-readiness logic. Pins
 * the aging thresholds, the company/period/kind roll-up, the dedup-key stability
 * (idempotency contract), tiering, and the close-readiness summary the close gate
 * consumes. Pure logic only — no Supabase, no wall-clock (asOf is a fixed ISO).
 */

import { describe, it, expect } from 'vitest';
import {
  ageInDays,
  periodOf,
  bucketKey,
  toConfidence,
  agingConfidence,
  aggregateLeakage,
  resolveLeakageTier,
  computeCloseReadiness,
  LEAKAGE_THRESHOLDS,
  type LeakageItem,
} from './uncategorized-leakage';
import type { TierPolicy } from '@/lib/trust/score-tier';

const ASOF = '2026-04-01T00:00:00.000Z';
const POLICY: TierPolicy = { autoThreshold: 0.85, reviewThreshold: 0.7, autoMaxCents: 1_000_000 };

// ── ageInDays / periodOf / bucketKey / toConfidence ──────────────────────────
describe('ageInDays', () => {
  it('counts whole days from the activity date to as-of', () => {
    expect(ageInDays('2026-03-17', ASOF)).toBe(15);
    expect(ageInDays('2026-04-01', ASOF)).toBe(0);
  });
  it('is +infinity for a missing/unparseable date (so it always ages in)', () => {
    expect(ageInDays(null, ASOF)).toBe(Number.POSITIVE_INFINITY);
    expect(ageInDays('not-a-date', ASOF)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('periodOf', () => {
  it('buckets to YYYY-MM', () => {
    expect(periodOf('2026-03-17')).toBe('2026-03');
    expect(periodOf('2026-03-17T12:34:00Z')).toBe('2026-03');
    expect(periodOf(null)).toBe('unknown');
  });
});

describe('bucketKey', () => {
  it('is stable and includes kind + company + period (the idempotency key)', () => {
    expect(bucketKey('uncoded_bank', 'loc1', '2026-03')).toBe('leak:uncoded_bank:loc1:2026-03');
    expect(bucketKey('unpaid_bill', null, '2026-03')).toBe('leak:unpaid_bill:none:2026-03');
  });
});

describe('toConfidence', () => {
  it('clamps into numeric(5,4)', () => {
    expect(toConfidence(0.9)).toBe(0.9);
    expect(toConfidence(1)).toBe(0.9999);
    expect(toConfidence(NaN)).toBe(0);
  });
});

describe('agingConfidence', () => {
  it('sits at the floor right at the aging threshold and rises with age', () => {
    expect(agingConfidence(LEAKAGE_THRESHOLDS.uncodedBankDays, 'uncoded_bank')).toBeCloseTo(
      LEAKAGE_THRESHOLDS.confidenceFloor,
      5,
    );
    expect(agingConfidence(LEAKAGE_THRESHOLDS.confidenceCeilDays, 'uncoded_bank')).toBeCloseTo(
      LEAKAGE_THRESHOLDS.confidenceCeil,
      5,
    );
    // monotonic in between
    expect(agingConfidence(30, 'uncoded_bank')).toBeGreaterThan(
      agingConfidence(20, 'uncoded_bank'),
    );
  });
  it('caps at the ceiling for very old items', () => {
    expect(agingConfidence(400, 'unpaid_bill')).toBeCloseTo(LEAKAGE_THRESHOLDS.confidenceCeil, 5);
  });
});

// ── aggregateLeakage: threshold filtering + roll-up ──────────────────────────
function item(over: Partial<LeakageItem>): LeakageItem {
  return {
    id: 'i1',
    kind: 'uncoded_bank',
    locationId: 'loc1',
    dateISO: '2026-03-01',
    amountCents: 100_000,
    ...over,
  };
}

describe('aggregateLeakage', () => {
  it('excludes items that have not yet aged past their kind threshold', () => {
    // a bank line 10 days old (< 15) is normal in-flight work, not leakage
    const buckets = aggregateLeakage([item({ dateISO: '2026-03-22' })], ASOF); // 10d
    expect(buckets).toHaveLength(0);
  });

  it('includes a bank line aged past 15 days', () => {
    const buckets = aggregateLeakage([item({ dateISO: '2026-03-16' })], ASOF); // 16d
    expect(buckets).toHaveLength(1);
    expect(buckets[0].kind).toBe('uncoded_bank');
    expect(buckets[0].count).toBe(1);
    expect(buckets[0].amountAtRiskCents).toBe(100_000);
  });

  it('applies the per-kind threshold (receipts/bills age at 30, not 15)', () => {
    const receipt = item({ id: 'r', kind: 'unposted_receipt', dateISO: '2026-03-10' }); // 22d
    expect(aggregateLeakage([receipt], ASOF)).toHaveLength(0); // < 30d
    const older = item({ id: 'r2', kind: 'unposted_receipt', dateISO: '2026-02-20' }); // 40d
    expect(aggregateLeakage([older], ASOF)).toHaveLength(1);
  });

  it('rolls items into one bucket per company + period + kind, summing $ and taking max age', () => {
    const buckets = aggregateLeakage(
      [
        item({ id: 'a', dateISO: '2026-03-01', amountCents: 100_000 }), // 31d
        item({ id: 'b', dateISO: '2026-03-05', amountCents: 250_000 }), // 27d
        // different period → separate bucket
        item({ id: 'c', dateISO: '2026-02-01', amountCents: 50_000 }),
        // different company → separate bucket
        item({ id: 'd', locationId: 'loc2', dateISO: '2026-03-02', amountCents: 999 }),
      ],
      ASOF,
    );
    const march1 = buckets.find((x) => x.dedupKey === 'leak:uncoded_bank:loc1:2026-03');
    expect(march1).toBeDefined();
    expect(march1!.count).toBe(2);
    expect(march1!.amountAtRiskCents).toBe(350_000);
    expect(march1!.maxAgeDays).toBe(31);
    expect(march1!.subjectIds).toEqual(['a', 'b']);
    // three distinct buckets total (loc1/03, loc1/02, loc2/03)
    expect(buckets).toHaveLength(3);
  });

  it('sign-normalizes amounts (money-out bank lines are negative cents)', () => {
    const buckets = aggregateLeakage(
      [item({ id: 'a', dateISO: '2026-03-01', amountCents: -80_000 })],
      ASOF,
    );
    expect(buckets[0].amountAtRiskCents).toBe(80_000);
  });

  it('sorts buckets by $-at-risk, largest hole first', () => {
    const buckets = aggregateLeakage(
      [
        item({ id: 'a', kind: 'uncoded_bank', dateISO: '2026-03-01', amountCents: 10_000 }),
        item({ id: 'b', kind: 'unpaid_bill', dateISO: '2026-02-01', amountCents: 900_000 }),
      ],
      ASOF,
    );
    expect(buckets[0].amountAtRiskCents).toBe(900_000);
  });

  it('produces a stable dedup_key across re-scans (idempotency contract)', () => {
    const first = aggregateLeakage([item({ id: 'a', dateISO: '2026-03-01' })], ASOF);
    const second = aggregateLeakage([item({ id: 'a', dateISO: '2026-03-01' })], ASOF);
    expect(first[0].dedupKey).toBe(second[0].dedupKey);
  });
});

// ── tiering ──────────────────────────────────────────────────────────────────
describe('resolveLeakageTier', () => {
  it('escalates a company/period hole at or above the materiality line', () => {
    expect(
      resolveLeakageTier(LEAKAGE_THRESHOLDS.escalateAtRiskCents, 0.9, POLICY),
    ).toBe('escalate');
  });
  it('reviews a below-materiality aged bucket (never auto-suppresses a control)', () => {
    // high confidence + small $ would be scoreToTier "auto"; a control must surface
    expect(resolveLeakageTier(5_000, 0.95, POLICY)).toBe('review');
  });
  it('reviews a mid-size sub-materiality bucket', () => {
    expect(resolveLeakageTier(500_000, 0.82, POLICY)).toBe('review');
  });
});

// ── close-readiness ──────────────────────────────────────────────────────────
describe('computeCloseReadiness', () => {
  it('rolls buckets into per-company/period rows and flags the blocking ones', () => {
    const cr = computeCloseReadiness([
      { locationId: 'loc1', period: '2026-03', kind: 'uncoded_bank', count: 3, amountAtRiskCents: 3_000_000, tier: 'escalate' },
      { locationId: 'loc1', period: '2026-03', kind: 'unpaid_bill', count: 1, amountAtRiskCents: 200_000, tier: 'review' },
      { locationId: 'loc2', period: '2026-03', kind: 'unposted_receipt', count: 2, amountAtRiskCents: 40_000, tier: 'review' },
    ]);
    expect(cr.totalItems).toBe(6);
    expect(cr.totalAtRiskCents).toBe(3_240_000);
    // loc1/2026-03 escalates (worst tier wins) → hard-blocking
    const loc1 = cr.byCompanyPeriod.find((r) => r.locationId === 'loc1');
    expect(loc1!.tier).toBe('escalate');
    expect(loc1!.atRiskCents).toBe(3_200_000);
    expect(loc1!.byKind.uncoded_bank).toBe(3_000_000);
    expect(loc1!.byKind.unpaid_bill).toBe(200_000);
    expect(cr.blockingItems).toBe(4); // both loc1 buckets roll into the escalating row
    expect(cr.blockingAtRiskCents).toBe(3_200_000);
    expect(cr.clean).toBe(false);
  });

  it('reports a clean close when nothing escalates', () => {
    const cr = computeCloseReadiness([
      { locationId: 'loc1', period: '2026-03', kind: 'uncoded_bank', count: 1, amountAtRiskCents: 5_000, tier: 'review' },
    ]);
    expect(cr.clean).toBe(true);
    expect(cr.blockingItems).toBe(0);
    expect(cr.byCompanyPeriod[0].blocksClose).toBe(true); // EC-4 buckets always block a *clean* close
  });

  it('is empty and clean with no leakage', () => {
    const cr = computeCloseReadiness([]);
    expect(cr.totalItems).toBe(0);
    expect(cr.clean).toBe(true);
    expect(cr.byCompanyPeriod).toHaveLength(0);
  });
});
