import { describe, it, expect } from 'vitest';
import {
  directMrrCents,
  directBreakdown,
  firmWholesaleCents,
  firmBreakdown,
  firmMrrCents,
  enterpriseBreakdown,
  planFor,
  usageFeeCents,
  FIRM_PLATFORM_FEE_CENTS,
} from './pricing';

// Supplementary EDGE cases (the primary examples live in pricing.test.ts).

describe('directMrrCents / directBreakdown — boundary counts', () => {
  it('is exactly 5×$99 at the base limit and one less below it', () => {
    expect(directMrrCents(5)).toBe(49500); // exactly 5 companies, all base
    expect(directMrrCents(4)).toBe(39600); // 4×99
  });

  it('crosses into the additional band at the 6th company', () => {
    expect(directMrrCents(6) - directMrrCents(5)).toBe(5900); // the 6th company adds $59
  });

  it('directBreakdown(0) has no lines and a $0 total', () => {
    const b = directBreakdown(0);
    expect(b.lines).toEqual([]);
    expect(b.mrrCents).toBe(0);
    expect(b.arrCents).toBe(0);
  });

  it('directBreakdown(1) has a single base line', () => {
    const b = directBreakdown(1);
    expect(b.lines).toHaveLength(1);
    expect(b.lines[0].quantity).toBe(1);
    expect(b.mrrCents).toBe(9900);
  });
});

describe('firmWholesaleCents — marginal tier crossovers', () => {
  it('prices a single client in the first band', () => {
    expect(firmWholesaleCents(1)).toBe(5900);
  });

  it('fills the first band exactly at 25', () => {
    expect(firmWholesaleCents(25)).toBe(25 * 5900);
  });

  it('spills the 26th client into the second band', () => {
    expect(firmWholesaleCents(26)).toBe(25 * 5900 + 1 * 4900);
  });

  it('fills bands one and two exactly at 100', () => {
    expect(firmWholesaleCents(100)).toBe(25 * 5900 + 75 * 4900);
  });
});

describe('firmBreakdown — populated bands only', () => {
  it('has just the platform fee at zero clients', () => {
    const b = firmBreakdown(0);
    expect(b.lines).toHaveLength(1);
    expect(b.lines[0].kind).toBe('platform_fee');
    expect(b.mrrCents).toBe(FIRM_PLATFORM_FEE_CENTS);
  });

  it('emits the platform fee + only the first band when clients fit in band one', () => {
    const b = firmBreakdown(10);
    expect(b.lines).toHaveLength(2); // platform + Clients 1–25
    expect(b.lines[1].quantity).toBe(10);
    expect(b.lines.reduce((s, l) => s + l.subtotalCents, 0)).toBe(b.mrrCents);
    expect(b.mrrCents).toBe(firmMrrCents(10));
  });
});

describe('enterpriseBreakdown — explicit $0 custom is honored (not treated as unset)', () => {
  it('keeps a custom amount of 0 rather than falling back to the direct formula', () => {
    const b = enterpriseBreakdown(30, 0);
    expect(b.usesCustom).toBe(true);
    expect(b.mrrCents).toBe(0);
    expect(b.lines[0].kind).toBe('custom');
  });
});

describe('planFor — custom-amount coercion edge cases', () => {
  it('trims and coerces a whitespace-padded numeric string', () => {
    expect(planFor({ billing_plan: 'enterprise', custom_mrr_cents: '  250000 ' }).customCents).toBe(250000);
  });

  it('floors a fractional custom amount', () => {
    expect(planFor({ billing_plan: 'enterprise', custom_mrr_cents: 1234.9 }).customCents).toBe(1234);
  });

  it('rejects a non-numeric custom amount as null', () => {
    expect(planFor({ billing_plan: 'enterprise', custom_mrr_cents: 'abc' }).customCents).toBeNull();
  });
});

describe('usageFeeCents — rounding', () => {
  it('rounds to the nearest cent (half-up)', () => {
    expect(usageFeeCents(12345, 'ach')).toBe(123); // 123.45 → 123
    expect(usageFeeCents(12355, 'card')).toBe(371); // 370.65 → 371
  });

  it('is $0 on non-positive amounts', () => {
    expect(usageFeeCents(-100, 'ach')).toBe(0);
    expect(usageFeeCents(0, 'card')).toBe(0);
  });
});
