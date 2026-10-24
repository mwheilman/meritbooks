import { describe, expect, it } from 'vitest';
import {
  addMonths,
  daysInMonth,
  fiscalPeriodOf,
  fiscalQuarterStart,
  fiscalYearOf,
  fiscalYearStart,
  monthRange,
  monthsBetween,
  shortMonthLabel,
  trailingMonths,
} from './months';
import { allocateCents, cagr, growthRate, roundCents, roundPreservingSum, stdev } from './numbers';
import { rollingSum, sliceSeries, ttmSeries, type MonthlySeries } from './series';
import { cagrLadder, momSeries, yoyDollarRow, yoyMarginRow, yoySeries } from './growth';

const series = (from: string, values: (number | null)[]): MonthlySeries => values.map((value, i) => ({ month: addMonths(from, i), value }));

describe('months', () => {
  it('arithmetic and ranges', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-11', 14)).toBe('2028-01');
    expect(monthsBetween('2025-10', '2026-09')).toBe(11);
    expect(monthRange('2026-11', '2027-02')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
    expect(trailingMonths('2026-09', 3)).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(daysInMonth('2024-02')).toBe(29);
    expect(daysInMonth('2026-02')).toBe(28);
    expect(shortMonthLabel('2026-08')).toBe('Aug ’26');
  });
  it('fiscal years', () => {
    expect(fiscalYearStart('2026-03', 7)).toBe('2025-07');
    expect(fiscalYearStart('2026-07', 7)).toBe('2026-07');
    expect(fiscalYearOf('2026-03', 7)).toBe(2026);
    expect(fiscalYearOf('2026-08', 7)).toBe(2027);
    expect(fiscalYearOf('2026-08', 1)).toBe(2026);
    expect(fiscalPeriodOf('2026-09', 7)).toBe(3);
    expect(fiscalQuarterStart('2026-12', 7)).toBe('2026-10');
    expect(() => fiscalYearStart('2026-01', 13)).toThrow();
    expect(() => addMonths('2026-13', 1)).toThrow();
  });
});

describe('numbers', () => {
  it('growth n/m rules', () => {
    expect(growthRate(125, 100).value).toBe(0.25);
    expect(growthRate(5, 0)).toEqual({ value: null, reason: 'zero_base' });
    expect(growthRate(5, -10)).toEqual({ value: null, reason: 'negative_base' });
    expect(growthRate(-5, 10)).toEqual({ value: null, reason: 'sign_flip' });
  });
  it('CAGR needs positive ends', () => {
    expect(cagr(1331, 1000, 3).value).toBeCloseTo(0.1, 12);
    expect(cagr(100, -5, 3).value).toBeNull();
  });
  it('rounds half away from zero, never -0', () => {
    expect(roundCents(2.5)).toBe(3);
    expect(roundCents(-2.5)).toBe(-3);
    expect(Object.is(roundCents(-0.4), 0)).toBe(true);
  });
  it('allocateCents sums exactly (largest remainder)', () => {
    expect(allocateCents(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateCents(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
    const parts = allocateCents(1_000_001, [3, 7, 11, 13]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1_000_001);
  });
  it('roundPreservingSum ties to the rounded total', () => {
    const out = roundPreservingSum([0.4, 0.4, 0.4]);
    expect(out.reduce((a, b) => a + b, 0)).toBe(1);
    expect(roundPreservingSum([1.5, -0.5], 1).reduce((a, b) => a + b, 0)).toBe(1);
  });
  it('sample stdev', () => {
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
    expect(stdev([1])).toBeNull();
  });
});

describe('series — gaps are never zero', () => {
  it('rolling sums go null across a gap', () => {
    const s = series('2026-01', [1, 2, null, 4, 5]);
    expect(rollingSum(s, 2).map((p) => p.value)).toEqual([null, 3, null, null, 9]);
  });
  it('normalizes missing interior months to explicit gaps', () => {
    const s: MonthlySeries = [
      { month: '2026-01', value: 1 },
      { month: '2026-03', value: 3 },
    ];
    expect(sliceSeries(s, '2026-01', '2026-04').map((p) => p.value)).toEqual([1, null, 3, null]);
  });
  it('TTM needs 12 months on file', () => {
    const s = series('2025-01', Array(13).fill(100));
    const t = ttmSeries(s);
    expect(t[10].value).toBeNull();
    expect(t[11].value).toBe(1200);
    expect(t[12].value).toBe(1200);
  });
});

describe('growth', () => {
  it('MoM and YoY', () => {
    const s = series('2025-01', [...Array(12).fill(100), 110, 90]);
    expect(momSeries(s)[12].value).toBeCloseTo(0.1, 12);
    expect(yoySeries(s)[12].value).toBeCloseTo(0.1, 12);
    expect(yoySeries(s)[13].value).toBeCloseTo(-0.1, 12);
    expect(yoySeries(s)[0]).toMatchObject({ value: null, reason: 'gap' });
  });
  it('YoY table: Month / FYTD / TTM in % for dollars', () => {
    const s = series('2024-10', [...Array(12).fill(100), ...Array(12).fill(120)]); // Oct 24 – Sep 26
    const row = yoyDollarRow(s, '2026-09', 1);
    expect(row.month).toMatchObject({ current: 120, prior: 100, change: 20, pct: 20 });
    expect(row.fytd).toMatchObject({ current: 1080, prior: 900, pct: 20 });
    expect(row.ttm).toMatchObject({ current: 1440, prior: 1200, pct: 20 });
  });
  it('YoY table: margins change in points', () => {
    const rev = series('2025-09', [1000, ...Array(11).fill(1000), 1000]);
    const gp = series('2025-09', [370, ...Array(11).fill(400), 400]);
    const row = yoyMarginRow(gp, rev, '2026-09', 1);
    expect(row.month).toMatchObject({ points: 3, pct: null });
    expect(row.month.current).toBeCloseTo(0.4, 12);
  });
  it('CAGR ladder 1/3/5 on TTM, "not enough history" where books are short', () => {
    const s = series('2021-10', [...Array(12).fill(1000), ...Array(24).fill(1100), ...Array(12).fill(1331)]); // Oct 21 – Sep 25
    const ladder = cagrLadder(s, '2025-09');
    expect(ladder[0].value).toBeCloseTo(0.21, 12); // 1331/1100
    expect(ladder[1].value).toBeCloseTo(0.1, 12); // (1331/1000)^(1/3)
    expect(ladder[2]).toMatchObject({ years: 5, value: null, reason: 'not_enough_history' });
  });
});
