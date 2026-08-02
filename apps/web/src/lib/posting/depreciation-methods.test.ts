import { describe, it, expect } from 'vitest';
import {
  straightLineSchedule,
  decliningBalanceSchedule,
  sumOfYearsDigitsSchedule,
  unitsOfProductionSchedule,
  buildDepreciationSchedule,
  cumulativeThrough,
  mapBookMethod,
  DepreciationInputError,
} from './depreciation-methods';

const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);

describe('straightLineSchedule', () => {
  it('divides the depreciable base evenly and lands exactly on the base', () => {
    const s = straightLineSchedule(120_000, 0, 12);
    expect(s).toHaveLength(12);
    expect(sum(s)).toBe(120_000);
    expect(s.every((x) => x === 10_000)).toBe(true);
  });

  it('absorbs rounding in the final month (no fractional cents, exact total)', () => {
    const s = straightLineSchedule(100_000, 1_000, 7); // base 99000 / 7 = 14142.85..
    expect(sum(s)).toBe(99_000);
    expect(s.slice(0, 6).every((x) => x === 14_142)).toBe(true);
    expect(s[6]).toBe(99_000 - 14_142 * 6);
  });

  it('honors salvage (never depreciates below it)', () => {
    const s = straightLineSchedule(50_000, 5_000, 10);
    expect(sum(s)).toBe(45_000);
  });
});

describe('decliningBalanceSchedule (200% / 150%)', () => {
  it('200% DDB is front-loaded, integer cents, and fully lands on the base', () => {
    const s = decliningBalanceSchedule(1_200_000, 0, 60, 2.0);
    expect(s).toHaveLength(60);
    expect(sum(s)).toBe(1_200_000); // switchover guarantees full write-down
    expect(s.every((x) => Number.isInteger(x))).toBe(true);
    expect(s[0]).toBeGreaterThan(s[59]); // accelerated: early > late... but late absorbs remainder
    // first-period charge ≈ rate(2/60) * cost = 40,000
    expect(s[0]).toBe(Math.round((2 / 60) * 1_200_000));
  });

  it('150% DB also lands exactly on the base and honors salvage', () => {
    const s = decliningBalanceSchedule(1_000_000, 100_000, 48, 1.5);
    expect(sum(s)).toBe(900_000); // base = cost - salvage
    // book value never driven below salvage
    let bv = 1_000_000;
    for (const amt of s) {
      bv -= amt;
      expect(bv).toBeGreaterThanOrEqual(100_000);
    }
  });

  it('is more accelerated than straight-line in year one', () => {
    const cost = 600_000;
    const ddb = decliningBalanceSchedule(cost, 0, 60, 2.0);
    const sl = straightLineSchedule(cost, 0, 60);
    const ddbY1 = cumulativeThrough(ddb, 11);
    const slY1 = cumulativeThrough(sl, 11);
    expect(ddbY1).toBeGreaterThan(slY1);
  });

  it('rejects a non-positive factor', () => {
    expect(() => decliningBalanceSchedule(100_000, 0, 12, 0)).toThrow(DepreciationInputError);
  });
});

describe('sumOfYearsDigitsSchedule', () => {
  it('is accelerated, integer cents, and lands exactly on the base', () => {
    const s = sumOfYearsDigitsSchedule(100_000, 0, 4);
    expect(s).toHaveLength(4);
    expect(sum(s)).toBe(100_000);
    // digits sum 1+2+3+4 = 10 → 4/10,3/10,2/10,1/10
    expect(s[0]).toBe(40_000);
    expect(s[1]).toBe(30_000);
    expect(s[2]).toBe(20_000);
    expect(s[3]).toBe(10_000);
    expect(s[0]).toBeGreaterThan(s[3]);
  });

  it('honors salvage and absorbs rounding at the end', () => {
    const s = sumOfYearsDigitsSchedule(99_999, 1_111, 5);
    expect(sum(s)).toBe(99_999 - 1_111);
  });
});

describe('unitsOfProductionSchedule', () => {
  it('charges proportional to usage and only depreciates as used', () => {
    const s = unitsOfProductionSchedule(500_000, 0, 100, [10, 20, 30]);
    expect(s).toEqual([50_000, 100_000, 150_000]);
    expect(sum(s)).toBe(300_000); // 60 of 100 units used → not fully depreciated
  });

  it('caps at the remaining base if usage exceeds the estimate', () => {
    const s = unitsOfProductionSchedule(100_000, 0, 100, [60, 60]);
    expect(sum(s)).toBe(100_000); // second period capped
    expect(s[1]).toBe(40_000);
  });

  it('rejects a non-positive total unit estimate', () => {
    expect(() => unitsOfProductionSchedule(100_000, 0, 0, [1])).toThrow(DepreciationInputError);
  });
});

describe('buildDepreciationSchedule dispatch + guards', () => {
  it('routes each method', () => {
    expect(sum(buildDepreciationSchedule({ costCents: 12_000, salvageCents: 0, usefulLifeMonths: 12, method: 'STRAIGHT_LINE' }))).toBe(12_000);
    expect(sum(buildDepreciationSchedule({ costCents: 12_000, salvageCents: 0, usefulLifeMonths: 12, method: 'DECLINING_BALANCE', decliningFactor: 2 }))).toBe(12_000);
    expect(sum(buildDepreciationSchedule({ costCents: 12_000, salvageCents: 0, usefulLifeMonths: 12, method: 'SUM_OF_YEARS_DIGITS' }))).toBe(12_000);
  });

  it('requires the declining factor / units inputs', () => {
    expect(() => buildDepreciationSchedule({ costCents: 12_000, salvageCents: 0, usefulLifeMonths: 12, method: 'DECLINING_BALANCE' })).toThrow(DepreciationInputError);
    expect(() => buildDepreciationSchedule({ costCents: 12_000, salvageCents: 0, usefulLifeMonths: 12, method: 'UNITS_OF_PRODUCTION' })).toThrow(DepreciationInputError);
  });

  it('rejects a zero/negative depreciable base', () => {
    expect(() => straightLineSchedule(1_000, 1_000, 12)).toThrow(DepreciationInputError);
  });
});

describe('mapBookMethod', () => {
  it('maps the book-postable enum values', () => {
    expect(mapBookMethod('STRAIGHT_LINE')).toEqual({ method: 'STRAIGHT_LINE' });
    expect(mapBookMethod('DOUBLE_DECLINING')).toEqual({ method: 'DECLINING_BALANCE', decliningFactor: 2.0 });
  });
  it('returns null for tax/unsupported enum values (reported, not guessed)', () => {
    expect(mapBookMethod('MACRS_5')).toBeNull();
    expect(mapBookMethod('SOMETHING_ELSE')).toBeNull();
  });
});
