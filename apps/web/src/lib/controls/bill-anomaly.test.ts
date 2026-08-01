/**
 * Bill / AP anomaly detection — pure logic. Pins the vendor-average variance math,
 * the first-time/large and round-dollar signals, the materiality floor + surfacing
 * cut-line, the signal aggregation (one exception per bill), tiering, and the
 * dedup-key stability (idempotency contract). No Supabase, no wall-clock.
 */

import { describe, it, expect } from 'vitest';
import {
  toConfidence,
  billAnomalyDedupKey,
  isRoundDollar,
  computeVendorHistory,
  scoreVendorVariance,
  scoreFirstTimeLarge,
  scoreRoundDollar,
  assessBillAnomaly,
  resolveBillAnomalyTier,
  BILL_ANOM_THRESHOLDS,
  type VendorHistory,
} from './bill-anomaly';
import type { TierPolicy } from '@/lib/trust/score-tier';

const POLICY: TierPolicy = { autoThreshold: 0.85, reviewThreshold: 0.7, autoMaxCents: 1_000_000 };
const T = BILL_ANOM_THRESHOLDS;

// ── helpers ───────────────────────────────────────────────────────────────────
describe('helpers', () => {
  it('toConfidence clamps into numeric(5,4)', () => {
    expect(toConfidence(1.5)).toBe(0.9999);
    expect(toConfidence(-1)).toBe(0);
    expect(toConfidence(0.865432)).toBe(0.8654);
    expect(toConfidence(NaN)).toBe(0);
  });

  it('billAnomalyDedupKey is stable and bill-scoped', () => {
    expect(billAnomalyDedupKey('abc')).toBe('billanom:abc');
    expect(billAnomalyDedupKey('abc')).toBe(billAnomalyDedupKey('abc'));
  });

  it('isRoundDollar only fires on non-zero exact multiples', () => {
    expect(isRoundDollar(500_000, 100_000)).toBe(true); // $5,000
    expect(isRoundDollar(512_300, 100_000)).toBe(false); // $5,123
    expect(isRoundDollar(0, 100_000)).toBe(false);
  });

  it('computeVendorHistory averages positive prior totals only', () => {
    expect(computeVendorHistory([100_000, 200_000, 300_000])).toEqual({
      count: 3,
      avgCents: 200_000,
      maxCents: 300_000,
    });
    // zero/negative are dropped
    expect(computeVendorHistory([0, -5, 100_000])).toEqual({
      count: 1,
      avgCents: 100_000,
      maxCents: 100_000,
    });
    expect(computeVendorHistory([])).toEqual({ count: 0, avgCents: 0, maxCents: 0 });
  });
});

// ── Signal A: vendor-average variance ───────────────────────────────────────────
describe('scoreVendorVariance', () => {
  const hist: VendorHistory = { count: 5, avgCents: 1_000_000, maxCents: 1_200_000 }; // avg $10k

  it('returns null without enough history', () => {
    const thin: VendorHistory = { count: T.minHistoryForAverage - 1, avgCents: 1_000_000, maxCents: 1_000_000 };
    expect(scoreVendorVariance({ totalCents: 5_000_000 }, thin, 'Acme')).toBeNull();
  });

  it('returns null when at/near the baseline (under 25% over)', () => {
    expect(scoreVendorVariance({ totalCents: 1_200_000 }, hist, 'Acme')).toBeNull(); // +20%
  });

  it('flags a 25%+ overage at review-strength (0.74)', () => {
    const sig = scoreVendorVariance({ totalCents: 1_300_000 }, hist, 'Acme'); // +30%
    expect(sig).not.toBeNull();
    expect(sig!.confidence).toBe(0.74);
    expect(sig!.amountAtRiskCents).toBe(300_000); // overage, not the full bill
    expect(sig!.reason).toContain('30%');
  });

  it('flags a 2x bill at strong-strength (0.86)', () => {
    const sig = scoreVendorVariance({ totalCents: 2_000_000 }, hist, 'Acme'); // 2.0x
    expect(sig!.confidence).toBe(0.86);
    expect(sig!.amountAtRiskCents).toBe(1_000_000);
  });

  it('flags a 3x+ bill at extreme-strength (0.93)', () => {
    const sig = scoreVendorVariance({ totalCents: 3_000_000 }, hist, 'Acme'); // 3.0x
    expect(sig!.confidence).toBe(0.93);
  });

  it('suppresses a variance whose overage is below the materiality floor', () => {
    // avg tiny so a 30% overage is real in ratio but trivial in dollars.
    const tiny: VendorHistory = { count: 4, avgCents: 100_000, maxCents: 120_000 }; // $1,000 avg
    // +50% ratio but overage = $500 < $1,000 floor.
    expect(scoreVendorVariance({ totalCents: 150_000 }, tiny, 'Acme')).toBeNull();
  });
});

// ── Signal C: first-time / large vendor ─────────────────────────────────────────
describe('scoreFirstTimeLarge', () => {
  const none: VendorHistory = { count: 0, avgCents: 0, maxCents: 0 };

  it('returns null once the vendor has enough history', () => {
    const est: VendorHistory = { count: T.minHistoryForAverage, avgCents: 1_000_000, maxCents: 1_000_000 };
    expect(scoreFirstTimeLarge({ totalCents: 9_999_999 }, est, 'Acme')).toBeNull();
  });

  it('returns null below the first-time materiality floor', () => {
    expect(scoreFirstTimeLarge({ totalCents: T.firstTimeMaterialityCents - 1 }, none, 'Acme')).toBeNull();
  });

  it('flags a first-ever material bill (0.72) with full amount at risk', () => {
    const sig = scoreFirstTimeLarge({ totalCents: 600_000 }, none, 'Acme');
    expect(sig!.confidence).toBe(0.72);
    expect(sig!.amountAtRiskCents).toBe(600_000);
    expect(sig!.reason).toContain('first bill ever');
  });

  it('flags a first-ever large bill more strongly (0.82)', () => {
    const sig = scoreFirstTimeLarge({ totalCents: T.largeAbsoluteCents }, none, 'Acme');
    expect(sig!.confidence).toBe(0.82);
  });
});

// ── Signal D: round-dollar ──────────────────────────────────────────────────────
describe('scoreRoundDollar', () => {
  it('returns null below the round-dollar minimum', () => {
    expect(scoreRoundDollar({ totalCents: 100_000 }, 'Acme')).toBeNull(); // $1,000 round but under $5k min
  });

  it('returns null for a non-round large amount', () => {
    expect(scoreRoundDollar({ totalCents: 512_345 }, 'Acme')).toBeNull();
  });

  it('flags a large exact round-dollar bill (0.71)', () => {
    const sig = scoreRoundDollar({ totalCents: 500_000 }, 'Acme');
    expect(sig!.confidence).toBe(0.71);
    expect(sig!.amountAtRiskCents).toBe(500_000);
  });
});

// ── Aggregation: one assessment per bill ────────────────────────────────────────
describe('assessBillAnomaly', () => {
  it('returns null when nothing fires', () => {
    const hist: VendorHistory = { count: 5, avgCents: 1_000_000, maxCents: 1_000_000 };
    expect(assessBillAnomaly({ totalCents: 1_050_000 }, hist, 'Acme')).toBeNull();
  });

  it('picks the highest-confidence signal as the driver and unions the kinds', () => {
    // avg $10k; a $30k EXACT round-dollar bill trips BOTH variance (3x → 0.93)
    // and round-dollar (0.71). Driver = variance.
    const hist: VendorHistory = { count: 5, avgCents: 1_000_000, maxCents: 1_000_000 };
    const a = assessBillAnomaly({ totalCents: 3_000_000 }, hist, 'Acme');
    expect(a).not.toBeNull();
    expect(a!.kind).toBe('vendor_variance');
    expect(a!.confidence).toBe(0.93);
    expect(a!.kinds).toContain('vendor_variance');
    expect(a!.kinds).toContain('round_dollar');
    // $-at-risk = max across signals (round-dollar carries the full $30k).
    expect(a!.amountAtRiskCents).toBe(3_000_000);
  });

  it('fires first_time_large for a new vendor with no baseline', () => {
    const none: VendorHistory = { count: 0, avgCents: 0, maxCents: 0 };
    const a = assessBillAnomaly({ totalCents: 700_000 }, none, 'NewCo');
    expect(a!.kind).toBe('first_time_large');
  });
});

// ── Tiering ─────────────────────────────────────────────────────────────────────
describe('resolveBillAnomalyTier', () => {
  it('floors auto up to review — a control must always reach a human', () => {
    // high confidence, small $ → scoreToTier would say auto; floored to review.
    expect(resolveBillAnomalyTier(0.95, 50_000, POLICY)).toBe('review');
  });

  it('escalates a high-confidence, large-dollar variance', () => {
    expect(resolveBillAnomalyTier(0.93, T.largeAbsoluteCents, POLICY)).toBe('escalate');
  });

  it('keeps a mid-confidence hit at review', () => {
    expect(resolveBillAnomalyTier(0.74, 300_000, POLICY)).toBe('review');
  });
});
