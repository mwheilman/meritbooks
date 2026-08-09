import { describe, it, expect } from 'vitest';
import {
  annualFactor,
  monthlyEquivalentCents,
  monthlyRunRateTrend,
  trendDelta,
  priceCreepList,
  totalAnnualizedCreepCents,
  type TrendSubscription,
} from './analytics';

// Supplementary EDGE cases (the primary examples live in analytics.test.ts).

describe('annualFactor — cadence normalization', () => {
  it('maps the known cadences case-insensitively', () => {
    expect(annualFactor('monthly')).toBe(12);
    expect(annualFactor('Quarterly')).toBe(4);
    expect(annualFactor('ANNUAL')).toBe(1);
  });

  it('treats unknown / empty cadence as monthly (12)', () => {
    expect(annualFactor('weekly')).toBe(12);
    expect(annualFactor('')).toBe(12);
    expect(annualFactor(null)).toBe(12);
    expect(annualFactor(undefined)).toBe(12);
  });
});

describe('monthlyEquivalentCents — rounding', () => {
  it('rounds the quarterly monthly-equivalent to the nearest cent', () => {
    // 1000 quarterly → 1000×4/12 = 333.33… → 333
    expect(monthlyEquivalentCents(1000, 'QUARTERLY')).toBe(333);
  });
});

function tsub(over: Partial<TrendSubscription>): TrendSubscription {
  return {
    amount_cents: 1000,
    prior_amount_cents: null,
    billing_cadence: 'MONTHLY',
    first_seen_date: '2026-01-15',
    last_charged_date: '2026-07-15',
    status: 'ACTIVE',
    ...over,
  };
}

describe('monthlyRunRateTrend — window clamping', () => {
  it('clamps monthsBack below 1 up to a single point', () => {
    expect(monthlyRunRateTrend([tsub({})], '2026-08-02', 0)).toHaveLength(1);
    expect(monthlyRunRateTrend([tsub({})], '2026-08-02', -5)).toHaveLength(1);
  });

  it('clamps monthsBack above 36 down to 36', () => {
    expect(monthlyRunRateTrend([tsub({})], '2026-08-02', 100)).toHaveLength(36);
  });

  it('returns [] on a non-array subs argument', () => {
    // @ts-expect-error deliberately wrong type
    expect(monthlyRunRateTrend(null, '2026-08-02', 6)).toEqual([]);
  });
});

describe('trendDelta — zero-base guard', () => {
  it('reports 0% when the first month is zero (no divide-by-zero)', () => {
    const d = trendDelta([
      { month: '2026-01', label: 'Jan', totalCents: 0, count: 0 },
      { month: '2026-02', label: 'Feb', totalCents: 5000, count: 1 },
    ]);
    expect(d.deltaCents).toBe(5000);
    expect(d.pct).toBe(0);
  });
});

describe('priceCreepList / totalAnnualizedCreepCents — empty inputs', () => {
  it('is safe on a non-array argument', () => {
    // @ts-expect-error deliberately wrong type
    expect(priceCreepList(undefined)).toEqual([]);
  });
  it('totals to zero for an empty list', () => {
    expect(totalAnnualizedCreepCents([])).toBe(0);
  });
});
