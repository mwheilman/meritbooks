import { describe, it, expect } from 'vitest';
import {
  macrsAnnualPercentages,
  macrsPercentSeries,
  macrsDbFactor,
  firstYearServiceFraction,
  computeTaxDepreciationSchedule,
  taxDepreciationForYear,
  quarterOf,
  MACRS_HALF_YEAR,
} from './tax-depreciation';

// Sum a cents schedule's yearly totals.
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('MACRS GDS factor + convention fractions', () => {
  it('uses 200% DB for 3/5/7/10-yr and 150% DB for 15/20-yr property', () => {
    expect(macrsDbFactor(3)).toBe(2.0);
    expect(macrsDbFactor(5)).toBe(2.0);
    expect(macrsDbFactor(7)).toBe(2.0);
    expect(macrsDbFactor(10)).toBe(2.0);
    expect(macrsDbFactor(15)).toBe(1.5);
    expect(macrsDbFactor(20)).toBe(1.5);
  });
  it('half-year is 0.5; mid-quarter uses the quarter mid-point fraction', () => {
    expect(firstYearServiceFraction('HALF_YEAR', 1)).toBeCloseTo(0.5, 10);
    expect(firstYearServiceFraction('MID_QUARTER', 1)).toBeCloseTo(10.5 / 12, 10);
    expect(firstYearServiceFraction('MID_QUARTER', 2)).toBeCloseTo(7.5 / 12, 10);
    expect(firstYearServiceFraction('MID_QUARTER', 3)).toBeCloseTo(4.5 / 12, 10);
    expect(firstYearServiceFraction('MID_QUARTER', 4)).toBeCloseTo(1.5 / 12, 10);
  });
  it('derives the placed-in-service quarter from a date', () => {
    expect(quarterOf('2026-01-15')).toBe(1);
    expect(quarterOf('2026-05-01')).toBe(2);
    expect(quarterOf('2026-08-31')).toBe(3);
    expect(quarterOf('2026-12-01')).toBe(4);
  });
});

describe('macrsAnnualPercentages — reproduces the published IRS tables', () => {
  it('reproduces the 5-year half-year table exactly (200% DB w/ SL switch)', () => {
    const pct = macrsAnnualPercentages(5, 'HALF_YEAR', 1).map((f) => Number((f * 100).toFixed(2)));
    expect(pct).toEqual([20.0, 32.0, 19.2, 11.52, 11.52, 5.76]);
  });
  it('reproduces the 7-year half-year table within the published ±0.01% rounding artifact', () => {
    const pct = macrsAnnualPercentages(7, 'HALF_YEAR', 1).map((f) => f * 100);
    const published = MACRS_HALF_YEAR[7];
    expect(pct.length).toBe(published.length);
    pct.forEach((p, i) => expect(Math.abs(p - published[i])).toBeLessThanOrEqual(0.011));
    // and both sum to 100%
    expect(sum(pct)).toBeCloseTo(100, 6);
  });
  it('reproduces the 5-year MID-QUARTER Q1 table exactly', () => {
    const pct = macrsAnnualPercentages(5, 'MID_QUARTER', 1).map((f) => Number((f * 100).toFixed(2)));
    expect(pct).toEqual([35.0, 26.0, 15.6, 11.01, 11.01, 1.38]);
  });
  it('every class/convention percentage series sums to 1.0', () => {
    for (const n of [3, 5, 7, 10, 15, 20]) {
      for (const q of [1, 2, 3, 4]) {
        expect(sum(macrsAnnualPercentages(n, 'MID_QUARTER', q))).toBeCloseTo(1, 8);
      }
      expect(sum(macrsAnnualPercentages(n, 'HALF_YEAR', 1))).toBeCloseTo(1, 8);
    }
  });
  it('macrsPercentSeries prefers the exact published half-year table', () => {
    expect(macrsPercentSeries(5, 'HALF_YEAR', 1)).toEqual(MACRS_HALF_YEAR[5].map((p) => p / 100));
  });
});

describe('computeTaxDepreciationSchedule — pure, integer-cents', () => {
  it('produces the published 5-year half-year schedule on $100,000 (no elections)', () => {
    const s = computeTaxDepreciationSchedule({
      costCents: 10_000_000,
      inServiceDate: '2026-06-15',
      method: 'MACRS',
      recoveryYears: 5,
      convention: 'HALF_YEAR',
    });
    expect(s.years.map((y) => y.totalCents)).toEqual([2_000_000, 3_200_000, 1_920_000, 1_152_000, 1_152_000, 576_000]);
    expect(s.years.map((y) => y.year)).toEqual([2026, 2027, 2028, 2029, 2030, 2031]);
    expect(s.totalCents).toBe(10_000_000); // MACRS recovers the full cost
    expect(s.depreciableBasisCents).toBe(10_000_000);
  });

  it('produces the published 7-year half-year schedule on $100,000', () => {
    const s = computeTaxDepreciationSchedule({
      costCents: 10_000_000,
      inServiceDate: '2026-03-01',
      method: 'MACRS',
      recoveryYears: 7,
      convention: 'HALF_YEAR',
    });
    expect(s.years.map((y) => y.totalCents)).toEqual([
      1_429_000, 2_449_000, 1_749_000, 1_249_000, 893_000, 892_000, 893_000, 446_000,
    ]);
    expect(s.totalCents).toBe(10_000_000);
  });

  it('applies §179 then bonus, recovering the remaining basis by MACRS', () => {
    // $100k, 5-yr; §179 $50k; 60% bonus on the post-179 basis.
    const s = computeTaxDepreciationSchedule({
      costCents: 10_000_000,
      inServiceDate: '2026-06-15',
      method: 'MACRS',
      recoveryYears: 5,
      convention: 'HALF_YEAR',
      section179Cents: 5_000_000,
      bonusPct: 60,
    });
    expect(s.section179Cents).toBe(5_000_000);
    expect(s.bonusCents).toBe(3_000_000); // 60% of (10,000,000 − 5,000,000)
    expect(s.depreciableBasisCents).toBe(2_000_000); // 10,000,000 − 5,000,000 − 3,000,000
    // Year 1 = §179 + bonus + 20% of remaining basis
    expect(s.years[0].totalCents).toBe(5_000_000 + 3_000_000 + 400_000);
    expect(s.years[1].totalCents).toBe(640_000); // 32% of 2,000,000
    expect(s.totalCents).toBe(10_000_000); // still recovers the whole cost across the life
  });

  it('§179 cannot exceed cost; bonus 100% fully expenses the post-179 basis in year 1', () => {
    const s = computeTaxDepreciationSchedule({
      costCents: 4_000_000,
      inServiceDate: '2026-02-01',
      method: 'MACRS',
      recoveryYears: 7,
      convention: 'HALF_YEAR',
      section179Cents: 9_999_999_999, // clamped to cost
      bonusPct: 100,
    });
    expect(s.section179Cents).toBe(4_000_000);
    expect(s.bonusCents).toBe(0);
    expect(s.depreciableBasisCents).toBe(0);
    expect(s.years[0].totalCents).toBe(4_000_000);
    expect(s.totalCents).toBe(4_000_000);
  });

  it('straight-line tax method honors salvage over the half-year convention', () => {
    // $12,000 cost, $2,000 salvage, 60-month (5-yr) SL → $10,000 base over 5 yrs, half-year.
    const s = computeTaxDepreciationSchedule({
      costCents: 1_200_000,
      inServiceDate: '2026-04-01',
      method: 'SL',
      taxLifeMonths: 60,
      salvageCents: 200_000,
    });
    expect(s.totalCents).toBe(1_000_000); // recovers cost − salvage
    // half-year: year 1 = half of the $2,000 annual = $1,000
    expect(s.years[0].totalCents).toBe(100_000);
    expect(s.years.length).toBe(6); // 5-year life spread over 6 tax years (half-year)
  });

  it('rejects an unsupported MACRS recovery class', () => {
    expect(() =>
      computeTaxDepreciationSchedule({ costCents: 100_000, inServiceDate: '2026-01-01', method: 'MACRS', recoveryYears: 4 }),
    ).toThrow();
  });

  it('taxDepreciationForYear extracts a single calendar year (0 outside the schedule)', () => {
    const s = computeTaxDepreciationSchedule({ costCents: 10_000_000, inServiceDate: '2026-06-15', method: 'MACRS', recoveryYears: 5 });
    expect(taxDepreciationForYear(s, 2027)).toBe(3_200_000);
    expect(taxDepreciationForYear(s, 2040)).toBe(0);
  });
});
