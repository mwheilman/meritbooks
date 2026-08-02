import { describe, it, expect } from 'vitest';
import { buildIntangibleAmortizationSchedule } from './amortization';
import { isIntangibleCategory, isNonAmortizing, INTANGIBLE_CATEGORIES } from './categories';

const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);

describe('isIntangibleCategory', () => {
  it('recognizes every canonical intangible category', () => {
    for (const c of INTANGIBLE_CATEGORIES) expect(isIntangibleCategory(c)).toBe(true);
  });
  it('recognizes any INTANGIBLE_-prefixed value (forward-compatible)', () => {
    expect(isIntangibleCategory('INTANGIBLE_FRANCHISE')).toBe(true);
  });
  it('rejects tangible categories and empty/null', () => {
    expect(isIntangibleCategory('EQUIPMENT')).toBe(false);
    expect(isIntangibleCategory('VEHICLE')).toBe(false);
    expect(isIntangibleCategory(null)).toBe(false);
    expect(isIntangibleCategory(undefined)).toBe(false);
    expect(isIntangibleCategory('')).toBe(false);
  });
});

describe('isNonAmortizing (goodwill rule)', () => {
  it('flags goodwill as non-amortizing (impairment-only)', () => {
    expect(isNonAmortizing('INTANGIBLE_GOODWILL')).toBe(true);
  });
  it('treats every other intangible as amortizing', () => {
    for (const c of INTANGIBLE_CATEGORIES) {
      if (c === 'INTANGIBLE_GOODWILL') continue;
      expect(isNonAmortizing(c)).toBe(false);
    }
  });
  it('is false for null / tangible categories', () => {
    expect(isNonAmortizing(null)).toBe(false);
    expect(isNonAmortizing('EQUIPMENT')).toBe(false);
  });
});

describe('buildIntangibleAmortizationSchedule — straight-line (the norm)', () => {
  it('divides the cost evenly over the useful life and lands exactly on the base', () => {
    // $600,000 patent, 5-year (60-month) life, no salvage.
    const s = buildIntangibleAmortizationSchedule({
      category: 'INTANGIBLE_PATENT',
      costCents: 60_000_000,
      usefulLifeMonths: 60,
    });
    expect(s).toHaveLength(60);
    expect(sum(s)).toBe(60_000_000);
    expect(s.every((x) => x === 1_000_000)).toBe(true);
  });

  it('absorbs rounding in the final month (integer cents, exact total)', () => {
    const s = buildIntangibleAmortizationSchedule({
      category: 'INTANGIBLE_SOFTWARE',
      costCents: 100_000,
      usefulLifeMonths: 7,
    });
    expect(sum(s)).toBe(100_000);
    expect(s.slice(0, 6).every((x) => x === 14_285)).toBe(true);
    expect(s[6]).toBe(100_000 - 14_285 * 6);
  });

  it('honors residual value (never amortizes below salvage)', () => {
    const s = buildIntangibleAmortizationSchedule({
      category: 'INTANGIBLE_LICENSE',
      costCents: 50_000,
      salvageCents: 5_000,
      usefulLifeMonths: 10,
    });
    expect(sum(s)).toBe(45_000);
  });

  it('defaults a non-life-based method (e.g. units) to straight-line for intangibles', () => {
    const sl = buildIntangibleAmortizationSchedule({
      category: 'INTANGIBLE_CUSTOMER_LIST',
      costCents: 1_200_000,
      usefulLifeMonths: 12,
      method: 'UNITS_OF_PRODUCTION',
    });
    expect(sl).toHaveLength(12);
    expect(sum(sl)).toBe(1_200_000);
    expect(sl.every((x) => x === 100_000)).toBe(true);
  });
});

describe('buildIntangibleAmortizationSchedule — goodwill is NOT amortized', () => {
  it('returns an empty schedule for goodwill regardless of life/cost', () => {
    const s = buildIntangibleAmortizationSchedule({
      category: 'INTANGIBLE_GOODWILL',
      costCents: 250_000_000,
      usefulLifeMonths: 120,
    });
    expect(s).toEqual([]);
    expect(sum(s)).toBe(0);
  });

  it('never produces periodic charges even with a useful life set', () => {
    const s = buildIntangibleAmortizationSchedule({
      category: 'INTANGIBLE_GOODWILL',
      costCents: 10_000_000,
      salvageCents: 0,
      usefulLifeMonths: 1,
    });
    expect(s.length).toBe(0);
  });
});
