import { describe, expect, it } from 'vitest';
import { formatRatio } from './ratio';
import { formatCompactMoney } from './money';
import { fluxChangeLabel } from '@/lib/close/flux/change-label';
import { contrastVerdict } from '@/lib/branding/palette';
import { labelEvery } from '@/components/charts/core/scale';
import { formatValue } from '@/components/charts/core/format';

describe('formatRatio — one ratio formatter (×)', () => {
  it('multiples, never percents', () => {
    expect(formatRatio(0.625)).toBe('0.63×');
    expect(formatRatio(1.25)).toBe('1.25×');
    expect(formatRatio(2.4, { trimZero: true })).toBe('2.4×');
    expect(formatRatio(-0.4)).toBe('−0.40×');
    expect(formatRatio(0.1, { delta: true })).toBe('+0.10×');
    expect(formatRatio(null)).toBe('—');
  });
  it('charts use it for ratio and multiple units', () => {
    expect(formatValue(0.62, 'ratio')).toBe('0.62×');
    expect(formatValue(1.25, 'multiple')).toBe('1.25×');
  });
});

describe('formatCompactMoney', () => {
  it('sign before the symbol, true minus', () => {
    expect(formatCompactMoney(-12_000_000)).toBe('−$120.0K');
    expect(formatCompactMoney(150_000_000)).toBe('$1.5M');
    expect(formatCompactMoney(51_200)).toBe('$512');
    expect(formatCompactMoney(null)).toBe('—');
  });
});

describe('flux change label', () => {
  it('0.00 vs 0.00 is "no activity", not "new"', () => {
    expect(fluxChangeLabel(null, 0, 0)).toBe('no activity');
    expect(fluxChangeLabel(null, 50_000, 0)).toBe('new');
    expect(fluxChangeLabel(1250, 112_500, 100_000)).toBe('+12.5%');
    expect(fluxChangeLabel(-500, 95_000, 100_000, { signed: false })).toBe('-5.0%');
  });
});

describe('brand contrast verdict', () => {
  it('3:1 clears large text / UI only — never just "passes" for #3B82F6 on white', () => {
    expect(contrastVerdict({ ratio: 3.68, min: 3, pass: true, required: false })).toBe('passes for large text and UI only (body text needs 4.5:1)');
    expect(contrastVerdict({ ratio: 5.17, min: 4.5, pass: true, required: true })).toBe('passes');
    expect(contrastVerdict({ ratio: 3.68, min: 4.5, pass: false, required: true })).toBe('needs 4.5:1');
  });
});

describe('chart axis labels thin by their real width', () => {
  it('long labels thin out instead of overlapping', () => {
    const short = Array.from({ length: 12 }, () => 'Jan');
    const long = Array.from({ length: 12 }, () => 'Sep 2026');
    expect(labelEvery(12, 360, 34, short)).toBe(2);
    expect(labelEvery(12, 360, 34, long)).toBeGreaterThan(2);
  });
});
