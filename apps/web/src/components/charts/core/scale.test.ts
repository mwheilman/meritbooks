import { describe, expect, it } from 'vitest';
import { axisLabels, compare, formatValue } from './format';
import { bandScale, extent, labelEvery, linearScale, niceStep, niceTicks, ticksForUnit } from './scale';

describe('niceStep', () => {
  it('rounds up to 1 · 2 · 2.5 · 5 × 10ⁿ', () => {
    expect(niceStep(0.7)).toBe(1);
    expect(niceStep(1.3)).toBe(2);
    expect(niceStep(2.2)).toBe(2.5);
    expect(niceStep(3)).toBe(5);
    expect(niceStep(7)).toBe(10);
    expect(niceStep(180_000)).toBe(200_000);
    expect(niceStep(0.03)).toBeCloseTo(0.05, 12);
  });
  it('integer steps never land on 2.5', () => {
    expect(niceStep(2.2, true)).toBe(5);
    expect(Number.isInteger(niceStep(0.4, true))).toBe(true);
  });
});

describe('niceTicks', () => {
  it('covers the data and is evenly stepped', () => {
    const t = niceTicks(13, 87, 4);
    expect(t.min).toBeLessThanOrEqual(13);
    expect(t.max).toBeGreaterThanOrEqual(87);
    for (let i = 1; i < t.ticks.length; i++) expect(t.ticks[i] - t.ticks[i - 1]).toBeCloseTo(t.step, 9);
  });

  it('has no float noise (0.1 + 0.2 never prints as 0.30000000000000004)', () => {
    const t = niceTicks(0, 0.3, 3);
    for (const v of t.ticks) expect(String(v)).not.toMatch(/0000000|9999999/);
    expect(t.ticks).toContain(0.3);
  });

  it('bars start at zero (zero baseline) even when every value is high', () => {
    const t = niceTicks(80_000_00, 95_000_00, 4, { zero: true });
    expect(t.min).toBe(0);
    expect(t.ticks[0]).toBe(0);
  });

  it('handles all-negative values with zero as the top', () => {
    const t = niceTicks(-480_00, -120_00, 4, { zero: true });
    expect(t.max).toBe(0);
    expect(t.min).toBeLessThanOrEqual(-480_00);
    expect(t.ticks).toContain(0);
  });

  it('mixed-sign values keep 0 on a tick', () => {
    const t = niceTicks(-37, 112, 5, { zero: true });
    expect(t.ticks).toContain(0);
    expect(t.min).toBeLessThan(0);
  });

  it('opens a flat series instead of collapsing to one tick', () => {
    const t = niceTicks(500, 500, 4);
    expect(t.ticks.length).toBeGreaterThan(1);
    expect(t.min).toBeLessThan(500);
    expect(t.max).toBeGreaterThan(500);
    const z = niceTicks(0, 0, 4);
    expect(z.ticks.length).toBeGreaterThan(1);
  });
});

describe('money ticks (integer cents)', () => {
  it('steps are whole dollars and integers', () => {
    const t = ticksForUnit(0, 1_234_567_89, 'money', 4, true);
    expect(t.step % 100).toBe(0);
    for (const v of t.ticks) expect(Number.isInteger(v)).toBe(true);
  });

  it('labels use one compact scale across the axis', () => {
    const t = ticksForUnit(0, 1_500_000_00, 'money', 3, true);
    const labels = axisLabels(t.ticks, 'money');
    expect(labels[0]).toBe('$0');
    expect(labels.every((l) => l === '$0' || l.endsWith('M'))).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('small money and negative money format sensibly', () => {
    expect(axisLabels([-50_000_00, 0, 50_000_00], 'money')).toEqual(['−$50K', '$0', '$50K']);
    expect(axisLabels([0, 250_00, 500_00], 'money')).toEqual(['$0', '$250', '$500']);
  });

  it('exact values come from integer cents, negatives in parentheses', () => {
    expect(formatValue(123_456_789, 'money')).toBe('$1,234,568');
    expect(formatValue(-1_250, 'money')).toBe('($12.50)');
    expect(formatValue(null, 'money')).toBe('—');
    expect(formatValue(1_240_000_00, 'money', { compact: true })).toBe('$1.2M');
  });
});

describe('percent + direction', () => {
  it('percent axis keeps labels distinct', () => {
    expect(axisLabels([0, 0.05, 0.1, 0.15], 'percent')).toEqual(['0%', '5%', '10%', '15%']);
    expect(axisLabels([0, 0.025, 0.05], 'percent')).toEqual(['0.0%', '2.5%', '5.0%']);
    expect(axisLabels([0, 2.5, 5], 'count')).toEqual(['0.0', '2.5', '5.0']);
    expect(axisLabels([0, 150_000_000, 300_000_000], 'money')).toEqual(['$0', '$1.5M', '$3.0M']);
  });

  it('improvement / erosion follow the metric direction', () => {
    expect(compare(110, 100, 'higher_is_better', 'count').tone).toBe('improvement');
    expect(compare(110, 100, 'lower_is_better', 'days').tone).toBe('erosion');
    expect(compare(100, 100, 'higher_is_better', 'count').tone).toBe('flat');
  });

  it('relative change is n/m when the base is ≤ 0 or the sign flips', () => {
    expect(compare(50_00, -20_00, 'higher_is_better', 'money').rel).toBeNull();
    expect(compare(-10_00, 20_00, 'higher_is_better', 'money').rel).toBeNull();
    expect(compare(120_00, 100_00, 'higher_is_better', 'money').rel).toBeCloseTo(0.2, 9);
    // margins move in points, never in percent-of-percent
    expect(compare(0.21, 0.18, 'higher_is_better', 'percent').rel).toBeNull();
  });
});

describe('scales', () => {
  it('linear scale maps and inverts (y inverted)', () => {
    const y = linearScale([0, 100], [200, 0]);
    expect(y(0)).toBe(200);
    expect(y(100)).toBe(0);
    expect(y.invert(100)).toBe(50);
  });

  it('band scale keeps bands inside the range and finds the index under a pixel', () => {
    const b = bandScale(12, [0, 600], 0.3, 0.1);
    expect(b.x(0)).toBeGreaterThanOrEqual(0);
    expect(b.x(11) + b.bandwidth).toBeLessThanOrEqual(600 + 1e-9);
    expect(b.indexAt(b.mid(5))).toBe(5);
    expect(b.indexAt(-50)).toBe(0);
    expect(b.indexAt(5000)).toBe(11);
  });

  it('extent ignores nulls (gaps) instead of treating them as zero', () => {
    expect(extent([null, 5, 9, null], [7])).toEqual([5, 9]);
    expect(extent([null, null])).toBeNull();
  });

  it('labelEvery thins crowded axes', () => {
    expect(labelEvery(24, 300, 36)).toBeGreaterThan(1);
    expect(labelEvery(12, 900, 36)).toBe(1);
  });
});
