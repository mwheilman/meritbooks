import { describe, it, expect } from 'vitest';
import { formatMarginPct, formatPctOfBase, NO_PCT, pctOfBase } from './percent';

describe('percent of base — zero base renders "—" (audit L8)', () => {
  it('a $50,000 expense on $0 revenue is "—", not 5,000,000%', () => {
    // Old code: Math.round(|5_000_000| / (|0| || 1) * 100) = 500,000,000%.
    expect(pctOfBase(5_000_000, 0)).toBeNull();
    expect(formatPctOfBase(5_000_000, 0, { decimals: 0, absolute: true })).toBe(NO_PCT);
    expect(formatPctOfBase(1_200, 0)).toBe('—');
  });

  it('normal bases', () => {
    expect(pctOfBase(25_000, 100_000)).toBe(25);
    expect(pctOfBase(1, 3, 2)).toBe(33.33);
    expect(formatPctOfBase(-12_500, 100_000, { absolute: true, decimals: 0 })).toBe('13%');
    expect(formatPctOfBase(12_500, 100_000, { signed: true })).toBe('+12.5%');
    // Negative base uses its magnitude (a negative-revenue period).
    expect(pctOfBase(10_000, -100_000)).toBe(10);
  });

  it('margins: "—" when revenue is zero', () => {
    expect(formatMarginPct(0, 0)).toBe('—');
    expect(formatMarginPct(120000, 0)).toBe('—');
    expect(formatMarginPct(12.5, 100_000)).toBe('12.5%');
    expect(formatMarginPct(null, 100_000)).toBe('—');
  });

  it('non-finite inputs never render a number', () => {
    expect(pctOfBase(Number.NaN, 100)).toBeNull();
    expect(pctOfBase(100, Number.POSITIVE_INFINITY)).toBeNull();
  });
});
