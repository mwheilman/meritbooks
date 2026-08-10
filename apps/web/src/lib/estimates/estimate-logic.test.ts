import { describe, it, expect } from 'vitest';
import {
  computeLineAmountCents,
  computeEstimateTotals,
  nextEstimateSeq,
  formatEstimateNumber,
  canSetStatus,
  canConvertEstimate,
} from './estimate-logic';

describe('estimate money math (cents)', () => {
  it('extends a line as round(qty * unit_price_cents)', () => {
    expect(computeLineAmountCents(3, 1999)).toBe(5997);
    expect(computeLineAmountCents(1, 0)).toBe(0);
    // Fractional quantity rounds to the nearest cent (matches invoice-create).
    expect(computeLineAmountCents(2.5, 1000)).toBe(2500);
    expect(computeLineAmountCents(0.333, 100)).toBe(33); // 33.3 → 33
  });

  it('is safe against non-numeric input', () => {
    expect(computeLineAmountCents(NaN, 100)).toBe(0);
    expect(computeLineAmountCents(1, NaN)).toBe(0);
  });

  it('rolls up subtotal, tax and total in cents', () => {
    const lines = [
      { quantity: 2, unit_price_cents: 5000 }, // 10000
      { quantity: 1, unit_price_cents: 2500 }, //  2500
      { quantity: 3, unit_price_cents: 999 },  //  2997
    ];
    const t = computeEstimateTotals(lines, 875);
    expect(t.subtotalCents).toBe(15497);
    expect(t.taxCents).toBe(875);
    expect(t.totalCents).toBe(16372);
  });

  it('defaults tax to 0 and never lets tax go negative', () => {
    expect(computeEstimateTotals([{ quantity: 1, unit_price_cents: 100 }]).totalCents).toBe(100);
    expect(computeEstimateTotals([{ quantity: 1, unit_price_cents: 100 }], -50).taxCents).toBe(0);
  });
});

describe('estimate numbering', () => {
  it('advances the per-org sequence from the current count', () => {
    expect(nextEstimateSeq(0)).toBe(1);
    expect(nextEstimateSeq(11)).toBe(12);
    expect(nextEstimateSeq(null)).toBe(1);
    expect(nextEstimateSeq(undefined)).toBe(1);
  });

  it('formats EST-{YYYYMMDD}-{seq4}', () => {
    expect(formatEstimateNumber('2026-08-09', 1)).toBe('EST-20260809-0001');
    expect(formatEstimateNumber('2026-12-31', 42)).toBe('EST-20261231-0042');
    expect(formatEstimateNumber('2026-01-01', 10000)).toBe('EST-20260101-10000');
  });
});

describe('lifecycle transitions', () => {
  it('allows manual moves between open statuses', () => {
    expect(canSetStatus('DRAFT', 'SENT').ok).toBe(true);
    expect(canSetStatus('SENT', 'ACCEPTED').ok).toBe(true);
    expect(canSetStatus('SENT', 'DECLINED').ok).toBe(true);
    expect(canSetStatus('EXPIRED', 'SENT').ok).toBe(true);
  });

  it('locks a converted estimate', () => {
    const r = canSetStatus('CONVERTED', 'DRAFT');
    expect(r.ok).toBe(false);
  });

  it('refuses to set CONVERTED by hand (must use convert)', () => {
    expect(canSetStatus('ACCEPTED', 'CONVERTED').ok).toBe(false);
  });

  it('rejects an unknown target status', () => {
    expect(canSetStatus('DRAFT', 'PAID').ok).toBe(false);
  });
});

describe('convert-to-invoice guard (double-convert is impossible)', () => {
  it('allows DRAFT / SENT / ACCEPTED with no invoice stamped', () => {
    expect(canConvertEstimate('DRAFT', null).ok).toBe(true);
    expect(canConvertEstimate('SENT', null).ok).toBe(true);
    expect(canConvertEstimate('ACCEPTED', null).ok).toBe(true);
  });

  it('blocks once an invoice id is present, regardless of status', () => {
    const r = canConvertEstimate('ACCEPTED', 'inv-123');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/already been converted/i);
  });

  it('blocks a CONVERTED / DECLINED / EXPIRED estimate', () => {
    expect(canConvertEstimate('CONVERTED', null).ok).toBe(false);
    expect(canConvertEstimate('DECLINED', null).ok).toBe(false);
    expect(canConvertEstimate('EXPIRED', null).ok).toBe(false);
  });
});
