import { describe, expect, it } from 'vitest';
import { computeBridge, gapIndexes, largestStep, lastIndex, percentileRanks, segments, shares, stack, trailingSum, variance } from './series';

describe('gaps are gaps, never zero', () => {
  it('segments break at nulls', () => {
    expect(segments([1, 2, null, 4, 5, null, null, 8])).toEqual([
      { start: 0, end: 1 },
      { start: 3, end: 4 },
      { start: 7, end: 7 },
    ]);
    expect(segments([null, null])).toEqual([]);
  });

  it('zero is data, not a gap', () => {
    expect(segments([0, 0, 0])).toEqual([{ start: 0, end: 2 }]);
    expect(gapIndexes([0, null, 3])).toEqual([1]);
  });

  it('lastIndex skips a trailing missing month', () => {
    expect(lastIndex([1, 2, 3, null])).toBe(2);
    expect(lastIndex([null])).toBe(-1);
  });

  it('TTM refuses to invent: any missing month in the window → null', () => {
    const months = Array.from({ length: 14 }, (_, i) => (i === 5 ? null : 100));
    const ttm = trailingSum(months, 12);
    expect(ttm.slice(0, 11).every((v) => v === null)).toBe(true);
    expect(ttm[11]).toBeNull(); // window contains the gap
    expect(ttm[12]).toBeNull();
    const full = trailingSum(Array.from({ length: 13 }, () => 100), 12);
    expect(full[11]).toBe(1200);
    expect(full[12]).toBe(1200);
  });
});

describe('waterfall running totals', () => {
  const steps = [
    { key: 'py', label: 'FY 2025 EBITDA', kind: 'start' as const, value: 1_800_000_00 },
    { key: 'gm', label: 'Gross margin', kind: 'delta' as const, value: 610_000_00 },
    { key: 'pay', label: 'Payroll', kind: 'delta' as const, value: -240_000_00 },
    { key: 'sub', label: 'Operating', kind: 'subtotal' as const, value: 0 },
    { key: 'oth', label: 'Other opex', kind: 'delta' as const, value: 50_000_00 },
    { key: 'cy', label: 'FY 2026 EBITDA', kind: 'end' as const, value: 2_220_000_00 },
  ];

  it('floats each delta from the running total and ties the end', () => {
    const b = computeBridge(steps);
    expect(b.bars.map((x) => x.running)).toEqual([1_800_000_00, 2_410_000_00, 2_170_000_00, 2_170_000_00, 2_220_000_00, 2_220_000_00]);
    expect(b.bars[1]).toMatchObject({ from: 1_800_000_00, to: 2_410_000_00, favourable: true });
    expect(b.bars[2]).toMatchObject({ from: 2_410_000_00, to: 2_170_000_00, favourable: false });
    expect(b.bars[3]).toMatchObject({ kind: 'subtotal', from: 0, to: 2_170_000_00 });
    expect(b.ties).toBe(true);
    expect(b.difference).toBe(0);
  });

  it('reports a bridge that does not tie', () => {
    const bad = steps.map((s) => (s.key === 'cy' ? { ...s, value: 2_230_000_00 } : s));
    const b = computeBridge(bad);
    expect(b.ties).toBe(false);
    expect(b.difference).toBe(10_000_00);
  });

  it('cost bridges flip favourable', () => {
    const b = computeBridge([
      { key: 's', label: 'Opex FY25', kind: 'start', value: 1000 },
      { key: 'd', label: 'Rent', kind: 'delta', value: 200 },
      { key: 'e', label: 'Opex FY26', kind: 'end', value: 1200 },
    ], 'lower_is_better');
    expect(b.bars[1].favourable).toBe(false);
  });

  it('largest step by magnitude', () => {
    expect(largestStep(computeBridge(steps))?.key).toBe('gm');
  });
});

describe('stack', () => {
  it('diverges: positives up from 0, negatives down from 0, nulls take no space', () => {
    const s = stack([[10, -5, null], [20, -5, 3]], 3);
    expect(s[0][0]).toEqual({ y0: 0, y1: 10, value: 10 });
    expect(s[1][0]).toEqual({ y0: 10, y1: 30, value: 20 });
    expect(s[0][1]).toEqual({ y0: -5, y1: 0, value: -5 });
    expect(s[1][1]).toEqual({ y0: -10, y1: -5, value: -5 });
    expect(s[0][2].value).toBeNull();
    expect(s[1][2]).toEqual({ y0: 0, y1: 3, value: 3 });
  });
});

describe('variance, shares, ranks', () => {
  it('variance F/U by direction; % n/m when plan ≤ 0', () => {
    expect(variance(120, 100, 'higher_is_better')).toEqual({ delta: 20, rel: 0.2, favourable: true });
    expect(variance(120, 100, 'lower_is_better').favourable).toBe(false);
    expect(variance(5, 0, 'higher_is_better').rel).toBeNull();
  });

  it('shares of the positive total; losses outside the 100%; top-N + others', () => {
    const r = shares(
      [
        { key: 'a', label: 'A', value: 500 },
        { key: 'b', label: 'B', value: 300 },
        { key: 'c', label: 'C', value: 100 },
        { key: 'd', label: 'D', value: 100 },
        { key: 'x', label: 'X', value: -50 },
        { key: 'n', label: 'N', value: null },
      ],
      2,
    );
    expect(r.total).toBe(1000);
    expect(r.items.map((i) => i.key)).toEqual(['a', 'b', '__other', 'x']);
    expect(r.items[0].share).toBeCloseTo(0.5, 9);
    expect(r.items[2]).toMatchObject({ value: 200, label: 'All others (2)' });
    expect(r.items[3]).toMatchObject({ loss: true, share: 0 });
    expect(r.lossTotal).toBe(-50);
  });

  it('percentile ranks honour direction and leave nulls unranked', () => {
    expect(percentileRanks([10, 30, null, 20], 'higher_is_better')).toEqual([0, 1, null, 0.5]);
    expect(percentileRanks([10, 30, null, 20], 'lower_is_better')).toEqual([1, 0, null, 0.5]);
    expect(percentileRanks([5, 5, 9], 'higher_is_better')).toEqual([0.25, 0.25, 1]);
  });
});
