/**
 * Fee resolver — exact-cent assertions for the Layer-1 fee MeritBooks charges.
 *
 * The headline case (§14 of the FPB): the old hardcoded "ACH 1% uncapped" booked
 * $1,500 on a $150,000 payment. Under "1% capped at $10" it is $10. That single
 * cap is the biggest correctness change in the fee module; it is asserted first.
 */

import { describe, it, expect } from 'vitest';
import { computeFee, DEFAULT_FEE_SCHEDULE, scheduleFromRow, type MerchantFeeSchedule } from './fees';

const sched = (over: Partial<MerchantFeeSchedule> = {}): MerchantFeeSchedule => ({
  achFeeBps: 100,
  achFeeCapCents: null,
  achFeeMinCents: null,
  cardFeeBps: 300,
  cardFeeCapCents: null,
  cardFeeMinCents: null,
  ...over,
});

const M150K = 15_000_000; // $150,000.00

describe('the cap correction (the bug the constants had)', () => {
  it('ACH 1% capped at $10 on a $150K payment is $10, not $1,500', () => {
    expect(computeFee(sched({ achFeeCapCents: 1000 }), 'ACH', M150K)).toBe(1000);
  });

  it('ACH 1% UNCAPPED on a $150K payment is $1,500 (the negotiable alternative)', () => {
    expect(computeFee(sched({ achFeeCapCents: null }), 'ACH', M150K)).toBe(150_000);
  });

  it('the cap does not bite below the cap amount', () => {
    // $500 ACH at 1% = $5, under the $10 cap → $5.
    expect(computeFee(sched({ achFeeCapCents: 1000 }), 'ACH', 50_000)).toBe(500);
  });
});

describe('basis-point math is exact integer cents', () => {
  it('1% of $100.00 = $1.00', () => {
    expect(computeFee(sched(), 'ACH', 10_000)).toBe(100);
  });

  it('3% of $100.00 = $3.00 (card)', () => {
    expect(computeFee(sched(), 'CARD', 10_000)).toBe(300);
  });

  it('rounds to the nearest cent', () => {
    // 1% of $9.99 = 9.99¢ → 10¢ (rounds up)
    expect(computeFee(sched(), 'ACH', 999)).toBe(10);
    // 1% of $9.40 = 9.40¢ → 9¢ (rounds down)
    expect(computeFee(sched(), 'ACH', 940)).toBe(9);
  });

  it('never returns a fraction of a cent', () => {
    for (const base of [1, 7, 33, 101, 9_999, 123_456]) {
      const fee = computeFee(sched(), 'CARD', base);
      expect(Number.isInteger(fee)).toBe(true);
    }
  });
});

describe('floor', () => {
  it('applies a minimum fee', () => {
    // 1% of $1.00 = 1¢, floor 50¢ → 50¢.
    expect(computeFee(sched({ achFeeMinCents: 50 }), 'ACH', 100)).toBe(50);
  });

  it('floor and cap together clamp both ends', () => {
    const s = sched({ achFeeMinCents: 50, achFeeCapCents: 1000 });
    expect(computeFee(s, 'ACH', 100)).toBe(50); // floored
    expect(computeFee(s, 'ACH', 5_000_000)).toBe(1000); // capped
    expect(computeFee(s, 'ACH', 20_000)).toBe(200); // in range
  });
});

describe('guards', () => {
  it('never charges more than the payment', () => {
    // 3% but cap absurdly high and base tiny → fee cannot exceed base.
    expect(computeFee(sched({ cardFeeBps: 10000 }), 'CARD', 5)).toBe(5);
  });

  it('a zero-rate schedule charges nothing', () => {
    expect(computeFee(sched({ achFeeBps: 0 }), 'ACH', M150K)).toBe(0);
  });

  it('a $0 payment has a $0 fee', () => {
    expect(computeFee(sched({ achFeeMinCents: 50 }), 'ACH', 0)).toBe(0);
  });

  it('rejects a negative or non-integer base', () => {
    expect(() => computeFee(sched(), 'ACH', -1)).toThrow();
    expect(() => computeFee(sched(), 'ACH', 10.5)).toThrow();
  });
});

describe('platform default schedule', () => {
  it('is ACH 1% / $10 cap, card 3% uncapped', () => {
    expect(computeFee(DEFAULT_FEE_SCHEDULE, 'ACH', M150K)).toBe(1000);
    expect(computeFee(DEFAULT_FEE_SCHEDULE, 'ACH', 50_000)).toBe(500);
    expect(computeFee(DEFAULT_FEE_SCHEDULE, 'CARD', 10_000)).toBe(300);
  });
});

describe('scheduleFromRow', () => {
  it('coerces string/numeric bigints and preserves nulls', () => {
    const s = scheduleFromRow({
      ach_fee_bps: 100, ach_fee_cap_cents: '1000', ach_fee_min_cents: null,
      card_fee_bps: 300, card_fee_cap_cents: null, card_fee_min_cents: '30',
    });
    expect(s.achFeeCapCents).toBe(1000);
    expect(s.achFeeMinCents).toBeNull();
    expect(s.cardFeeCapCents).toBeNull();
    expect(s.cardFeeMinCents).toBe(30);
  });
});
