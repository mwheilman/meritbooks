import { describe, it, expect } from 'vitest';
import {
  directMrrCents,
  directBreakdown,
  firmMrrCents,
  firmWholesaleCents,
  firmBreakdown,
  enterpriseMrrCents,
  enterpriseBreakdown,
  planMrrCents,
  planBreakdown,
  planFor,
  orgBreakdown,
  usageFeeCents,
  isBillingPlan,
  FIRM_PLATFORM_FEE_CENTS,
} from './pricing';

describe('directMrrCents — $99 first 5, $59 after', () => {
  it('matches the approved examples', () => {
    expect(directMrrCents(1)).toBe(9900); // $99
    expect(directMrrCents(5)).toBe(49500); // $495
    expect(directMrrCents(6)).toBe(55400); // $554 = 5×99 + 1×59
    expect(directMrrCents(17)).toBe(120300); // $1,203 = 5×99 + 12×59
    expect(directMrrCents(25)).toBe(167500); // $1,675 = 5×99 + 20×59
  });

  it('is $0 at zero / negative / non-finite counts', () => {
    expect(directMrrCents(0)).toBe(0);
    expect(directMrrCents(-3)).toBe(0);
    expect(directMrrCents(NaN)).toBe(0);
  });

  it('floors fractional counts', () => {
    expect(directMrrCents(2.9)).toBe(directMrrCents(2));
  });

  it('breakdown sums to the total and splits base vs additional', () => {
    const b = directBreakdown(17);
    expect(b.plan).toBe('direct');
    expect(b.count).toBe(17);
    expect(b.mrrCents).toBe(120300);
    expect(b.arrCents).toBe(120300 * 12);
    expect(b.lines.reduce((s, l) => s + l.subtotalCents, 0)).toBe(120300);
    expect(b.lines).toHaveLength(2); // 5 base + 12 additional
    expect(b.lines[0].quantity).toBe(5);
    expect(b.lines[1].quantity).toBe(12);
  });

  it('breakdown has only the base line at <= 5 companies', () => {
    const b = directBreakdown(3);
    expect(b.lines).toHaveLength(1);
    expect(b.lines[0].quantity).toBe(3);
    expect(b.mrrCents).toBe(29700);
  });
});

describe('firmMrrCents — $499 platform + marginal wholesale ($59/$49/$39)', () => {
  it('matches the approved tier-boundary examples', () => {
    // 25 clients all in tier 1: 25×59 = 1475 + 499 = 1974
    expect(firmMrrCents(25)).toBe(197400);
    // 26: 25×59 + 1×49 = 1524 + 499 = 2023
    expect(firmMrrCents(26)).toBe(202300);
    // 100: 25×59 + 75×49 = 5150 + 499 = 5649
    expect(firmMrrCents(100)).toBe(564900);
    // 101: 25×59 + 75×49 + 1×39 = 5189 + 499 = 5688
    expect(firmMrrCents(101)).toBe(568800);
  });

  it('is just the platform fee at zero clients', () => {
    expect(firmMrrCents(0)).toBe(FIRM_PLATFORM_FEE_CENTS);
    expect(firmWholesaleCents(0)).toBe(0);
  });

  it('wholesale is marginal, not flat', () => {
    // 101 clients: NOT 101×39. Marginal across bands.
    expect(firmWholesaleCents(101)).toBe(25 * 5900 + 75 * 4900 + 1 * 3900);
  });

  it('breakdown sums to the total, platform fee first', () => {
    const b = firmBreakdown(101);
    expect(b.plan).toBe('firm');
    expect(b.mrrCents).toBe(568800);
    expect(b.arrCents).toBe(568800 * 12);
    expect(b.lines[0].kind).toBe('platform_fee');
    expect(b.lines.reduce((s, l) => s + l.subtotalCents, 0)).toBe(568800);
    // platform fee + 3 populated bands
    expect(b.lines).toHaveLength(4);
  });
});

describe('enterpriseMrrCents — custom amount or direct fallback', () => {
  it('uses the custom amount when provided', () => {
    expect(enterpriseMrrCents(30, 250000)).toBe(250000);
    expect(enterpriseMrrCents(1, 0)).toBe(0); // an explicit $0 custom is honored
  });

  it('falls back to the direct formula when no custom amount', () => {
    // direct(30) = 5×99 + 25×59 = 49500 + 147500 = 197000
    expect(enterpriseMrrCents(30, null)).toBe(197000);
    expect(enterpriseMrrCents(30, undefined)).toBe(directMrrCents(30));
  });

  it('ignores a negative / non-finite custom amount (falls back)', () => {
    expect(enterpriseMrrCents(30, -100)).toBe(directMrrCents(30));
    expect(enterpriseMrrCents(30, NaN)).toBe(directMrrCents(30));
  });

  it('breakdown flags custom vs fallback', () => {
    const custom = enterpriseBreakdown(30, 250000);
    expect(custom.usesCustom).toBe(true);
    expect(custom.mrrCents).toBe(250000);
    expect(custom.lines[0].kind).toBe('custom');

    const fallback = enterpriseBreakdown(30, null);
    expect(fallback.usesCustom).toBe(false);
    expect(fallback.plan).toBe('enterprise');
    expect(fallback.mrrCents).toBe(197000);
  });
});

describe('planMrrCents / planBreakdown dispatch', () => {
  it('routes to the right plan', () => {
    expect(planMrrCents('direct', 17)).toBe(120300);
    expect(planMrrCents('firm', 100)).toBe(564900);
    expect(planMrrCents('enterprise', 30, 250000)).toBe(250000);
    expect(planMrrCents('enterprise', 30)).toBe(197000);
  });

  it('planBreakdown mrrCents agrees with planMrrCents', () => {
    for (const [plan, count, custom] of [
      ['direct', 8, null],
      ['firm', 60, null],
      ['enterprise', 40, 333300],
      ['enterprise', 40, null],
    ] as const) {
      expect(planBreakdown(plan, count, custom).mrrCents).toBe(planMrrCents(plan, count, custom));
    }
  });
});

describe('planFor / orgBreakdown org helper', () => {
  it('normalizes valid + invalid plans', () => {
    expect(planFor({ billing_plan: 'firm' })).toEqual({ plan: 'firm', customCents: null });
    expect(planFor({ billing_plan: 'nonsense' })).toEqual({ plan: 'direct', customCents: null });
    expect(planFor(null)).toEqual({ plan: 'direct', customCents: null });
  });

  it('coerces a stored custom amount (bigint serializes as string)', () => {
    expect(planFor({ billing_plan: 'enterprise', custom_mrr_cents: '250000' })).toEqual({
      plan: 'enterprise',
      customCents: 250000,
    });
    expect(planFor({ billing_plan: 'enterprise', custom_mrr_cents: -5 }).customCents).toBeNull();
  });

  it('orgBreakdown resolves plan + count end to end', () => {
    expect(orgBreakdown({ billing_plan: 'direct' }, 25).mrrCents).toBe(167500);
    expect(orgBreakdown({ billing_plan: 'enterprise', custom_mrr_cents: '999900' }, 30).mrrCents).toBe(999900);
  });
});

describe('usageFeeCents — informational only', () => {
  it('applies 1% ACH and 3% card', () => {
    expect(usageFeeCents(100000, 'ach')).toBe(1000); // $1,000 × 1% = $10
    expect(usageFeeCents(100000, 'card')).toBe(3000); // $1,000 × 3% = $30
    expect(usageFeeCents(0, 'ach')).toBe(0);
  });
});

describe('isBillingPlan guard', () => {
  it('accepts only the three plans', () => {
    expect(isBillingPlan('direct')).toBe(true);
    expect(isBillingPlan('firm')).toBe(true);
    expect(isBillingPlan('enterprise')).toBe(true);
    expect(isBillingPlan('pro')).toBe(false);
    expect(isBillingPlan(null)).toBe(false);
  });
});
