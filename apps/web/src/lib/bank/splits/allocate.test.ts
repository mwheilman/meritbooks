import { describe, it, expect } from 'vitest';
import {
  allocateByPercent,
  checkSplitAmounts,
  formatBp,
  parsePercentToBp,
  percentagesFromAmounts,
  remainingCents,
} from './allocate';
import { applySplitAllocations, matchSplitRule, normalizePattern, type SplitRuleRow } from './rules';

const A = '00000000-0000-4000-8000-00000000000a';
const ACCT1 = '00000000-0000-4000-8000-000000000001';
const ACCT2 = '00000000-0000-4000-8000-000000000002';

describe('allocateByPercent (AC-1: % rounding to the cent, remainder to last line)', () => {
  it('33.33 / 33.33 / 33.34 of $100.00', () => {
    expect(allocateByPercent(10_000, [3333, 3333, 3334])).toEqual([3333, 3333, 3334]);
  });
  it('a third each of $0.10 puts the remainder on the last line', () => {
    expect(allocateByPercent(10, [3333, 3333, 3334])).toEqual([3, 3, 4]);
  });
  it('sums to the total exactly for awkward amounts', () => {
    for (const total of [1, 7, 99, 12_345, 987_654_321]) {
      const out = allocateByPercent(total, [1250, 3750, 2500, 2500]);
      expect(out.reduce((s, a) => s + a, 0)).toBe(total);
      expect(out.every((a) => Number.isInteger(a) && a >= 0)).toBe(true);
    }
  });
  it('60/40 of $123.45 → 74.07 / 49.38 (AC-8)', () => {
    expect(allocateByPercent(12_345, [6000, 4000])).toEqual([7407, 4938]);
  });
  it('does not invent a remainder when the percentages do not reach 100%', () => {
    const out = allocateByPercent(10_000, [5000, 2500]);
    expect(out).toEqual([5000, 2500]);
    expect(remainingCents(10_000, out)).toBe(2500);
  });
  it('rejects non-integer cents and out-of-range percentages', () => {
    expect(() => allocateByPercent(10.5, [10_000])).toThrow();
    expect(() => allocateByPercent(100, [10_001])).toThrow();
  });
});

describe('percent text + basis points', () => {
  it('parses and formats without floating point', () => {
    expect(parsePercentToBp('33.33')).toBe(3333);
    expect(parsePercentToBp('33.333')).toBe(3333);
    expect(parsePercentToBp('60')).toBe(6000);
    expect(parsePercentToBp('7.5%')).toBe(750);
    expect(parsePercentToBp('100')).toBe(10_000);
    expect(parsePercentToBp('100.01')).toBeNull();
    expect(parsePercentToBp('abc')).toBeNull();
    expect(formatBp(3333)).toBe('33.33');
    expect(formatBp(750)).toBe('7.50');
  });
  it('amounts → basis points always total 100%', () => {
    expect(percentagesFromAmounts([6000, 4000])).toEqual([6000, 4000]);
    const bps = percentagesFromAmounts([1, 1, 1]);
    expect(bps.reduce((s, b) => s + b, 0)).toBe(10_000);
  });
});

describe('checkSplitAmounts (AC-5)', () => {
  it('accepts an exact split', () => {
    expect(checkSplitAmounts(18_640, [10_000, 8_640]).ok).toBe(true);
  });
  it('rejects short, over, zero, fractional and empty splits with a reason', () => {
    expect(checkSplitAmounts(18_640, [10_000, 7_400])).toMatchObject({ ok: false, error: expect.stringContaining('$12.40 short') });
    expect(checkSplitAmounts(100, [60, 50])).toMatchObject({ ok: false, error: expect.stringContaining('over') });
    expect(checkSplitAmounts(100, [100, 0]).ok).toBe(false);
    expect(checkSplitAmounts(100, [50.5, 49.5]).ok).toBe(false);
    expect(checkSplitAmounts(100, []).ok).toBe(false);
  });
});

describe('split rules (AC-8: application + precedence)', () => {
  const alloc = [
    { percent_bp: 6000, account_id: ACCT1, allocation_location_id: A },
    { percent_bp: 4000, account_id: ACCT2, allocation_location_id: A },
  ];
  const rule = (over: Partial<SplitRuleRow>): SplitRuleRow => ({
    id: over.id ?? 'r', name: over.name ?? 'r', location_id: null, vendor_id: null,
    description_pattern: null, allocations: alloc, is_active: true, ...over,
  });
  const V = 'vendor-verizon';

  it('applies a 60/40 rule to the transaction total', () => {
    const lines = applySplitAllocations(12_345, alloc);
    expect(lines.map((l) => l.amount_cents)).toEqual([7407, 4938]);
    expect(lines.map((l) => l.line_no)).toEqual([1, 2]);
  });

  it('prefers vendor + company over vendor-only over a description pattern', () => {
    const rules = [
      rule({ id: 'pattern', description_pattern: 'verizon wireless' }),
      rule({ id: 'vendor-org', vendor_id: V }),
      rule({ id: 'vendor-co', vendor_id: V, location_id: A }),
    ];
    const m = { vendorId: V, description: 'VERIZON WIRELESS 8812', locationId: A };
    expect(matchSplitRule(rules, m)?.id).toBe('vendor-co');
    expect(matchSplitRule(rules.slice(0, 2), m)?.id).toBe('vendor-org');
    expect(matchSplitRule(rules.slice(0, 1), m)?.id).toBe('pattern');
    expect(matchSplitRule(rules.slice(0, 1), { ...m, description: 'COMCAST' })).toBeNull();
  });

  it('skips inactive, other-company and malformed rules', () => {
    const m = { vendorId: V, description: 'x', locationId: A };
    expect(matchSplitRule([rule({ vendor_id: V, is_active: false })], m)).toBeNull();
    expect(matchSplitRule([rule({ vendor_id: V, location_id: 'other' })], m)).toBeNull();
    expect(matchSplitRule([rule({ vendor_id: V, allocations: [{ percent_bp: 5000, account_id: ACCT1, allocation_location_id: A }] })], m)).toBeNull();
  });

  it('normalizes patterns consistently', () => {
    expect(normalizePattern('  Verizon*Wireless   PMT ')).toBe('verizon wireless pmt');
  });
});
