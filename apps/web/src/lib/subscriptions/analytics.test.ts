import { describe, it, expect } from 'vitest';
import {
  monthlyEquivalentCents,
  annualizedFromAmount,
  monthlyRunRateTrend,
  trendDelta,
  priceCreepList,
  totalAnnualizedCreepCents,
  type TrendSubscription,
  type CreepSubscription,
} from './analytics';

describe('monthlyEquivalentCents / annualizedFromAmount', () => {
  it('converts each cadence to a monthly-equivalent', () => {
    expect(monthlyEquivalentCents(1200, 'MONTHLY')).toBe(1200);
    expect(monthlyEquivalentCents(1200, 'QUARTERLY')).toBe(400);
    expect(monthlyEquivalentCents(1200, 'ANNUAL')).toBe(100);
    expect(monthlyEquivalentCents(1200, 'OTHER')).toBe(1200);
  });

  it('annualizes each cadence', () => {
    expect(annualizedFromAmount(1000, 'MONTHLY')).toBe(12000);
    expect(annualizedFromAmount(1000, 'QUARTERLY')).toBe(4000);
    expect(annualizedFromAmount(1000, 'ANNUAL')).toBe(1000);
  });

  it('is safe on missing / non-positive amounts', () => {
    expect(monthlyEquivalentCents(null, 'MONTHLY')).toBe(0);
    expect(annualizedFromAmount(0, 'MONTHLY')).toBe(0);
    expect(monthlyEquivalentCents(-500, 'MONTHLY')).toBe(0);
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

describe('monthlyRunRateTrend', () => {
  const asOf = '2026-08-02';

  it('returns one point per trailing month, oldest→newest', () => {
    const pts = monthlyRunRateTrend([tsub({})], asOf, 6);
    expect(pts).toHaveLength(6);
    expect(pts[0].month).toBe('2026-03');
    expect(pts[5].month).toBe('2026-08');
    expect(pts[5].label).toBe('Aug');
  });

  it('excludes a subscription from months before it was first seen', () => {
    const pts = monthlyRunRateTrend([tsub({ first_seen_date: '2026-06-10', amount_cents: 5000 })], asOf, 6);
    // Mar, Apr, May are before first-seen → zero; Jun, Jul, Aug → 5000/mo.
    expect(pts.map((p) => p.totalCents)).toEqual([0, 0, 0, 5000, 5000, 5000]);
  });

  it('steps the run-rate up at the increase (prior amount before last charge month)', () => {
    // prior 1000, current 1500, latest charge 2026-07-15 → months up to Jun use 1000, Jul+ use 1500.
    const pts = monthlyRunRateTrend(
      [tsub({ prior_amount_cents: 1000, amount_cents: 1500, last_charged_date: '2026-07-15' })],
      asOf,
      4,
    );
    // May, Jun = 1000; Jul, Aug = 1500.
    expect(pts.map((p) => p.totalCents)).toEqual([1000, 1000, 1500, 1500]);
  });

  it('drops CANCELLED subscriptions entirely', () => {
    const pts = monthlyRunRateTrend([tsub({ status: 'CANCELLED' })], asOf, 3);
    expect(pts.every((p) => p.totalCents === 0 && p.count === 0)).toBe(true);
  });

  it('never throws on a bad asOf', () => {
    expect(monthlyRunRateTrend([tsub({})], 'not-a-date', 6)).toEqual([]);
  });
});

describe('trendDelta', () => {
  it('computes first→last change and pct', () => {
    const d = trendDelta([
      { month: '2026-01', label: 'Jan', totalCents: 1000, count: 1 },
      { month: '2026-02', label: 'Feb', totalCents: 1500, count: 1 },
    ]);
    expect(d.deltaCents).toBe(500);
    expect(d.pct).toBeCloseTo(0.5);
  });

  it('is safe on empty input', () => {
    expect(trendDelta([])).toEqual({ firstCents: 0, lastCents: 0, deltaCents: 0, pct: 0 });
  });
});

function csub(over: Partial<CreepSubscription> & { id: string }): CreepSubscription {
  return {
    vendor_name: 'Acme',
    product: null,
    category: null,
    billing_cadence: 'MONTHLY',
    amount_cents: 1500,
    prior_amount_cents: 1000,
    next_renewal_date: '2026-09-01',
    last_charged_date: '2026-07-15',
    status: 'ACTIVE',
    creep_flags: ['PRICE_INCREASE'],
    ...over,
  };
}

describe('priceCreepList', () => {
  it('lists only subscriptions with a known prior amount below the current', () => {
    const list = priceCreepList([
      csub({ id: 'up' }),
      csub({ id: 'noprior', prior_amount_cents: null }),
      csub({ id: 'flat', prior_amount_cents: 1500, amount_cents: 1500 }),
    ]);
    expect(list.map((i) => i.id)).toEqual(['up']);
    expect(list[0].deltaCents).toBe(500);
    expect(list[0].pct).toBeCloseTo(0.5);
    expect(list[0].annualizedDeltaCents).toBe(6000); // 500/mo * 12
  });

  it('ranks by annualized impact, biggest bleed first', () => {
    const list = priceCreepList([
      csub({ id: 'small', prior_amount_cents: 1000, amount_cents: 1100, billing_cadence: 'MONTHLY' }), // +100/mo → 1200/yr
      csub({ id: 'big', prior_amount_cents: 10000, amount_cents: 12000, billing_cadence: 'ANNUAL' }), // +2000/yr
    ]);
    expect(list.map((i) => i.id)).toEqual(['big', 'small']);
    expect(totalAnnualizedCreepCents(list)).toBe(1200 + 2000);
  });

  it('excludes cancelled subscriptions', () => {
    expect(priceCreepList([csub({ id: 'x', status: 'CANCELLED' })])).toHaveLength(0);
  });
});
