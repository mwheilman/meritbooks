/**
 * EC-1 duplicate-detection matching logic — locks the three detection rules and
 * their thresholds. These are the guardrail: change a cut-line and every queued
 * exception (and its tier) shifts, so the assertions pin the documented behavior.
 *
 * Pure logic only — no Supabase, no Date.now (dates are fixed ISO strings).
 */

import { describe, it, expect } from 'vitest';
import {
  scoreDuplicateBills,
  scoreDuplicateVendors,
  assessBillPayments,
  resolveDupTier,
  normalizeInvoiceNumber,
  pairKey,
  toConfidence,
  DUP_THRESHOLDS,
  type DupBillInput,
  type DupVendorInput,
} from './duplicate-payments';
import type { TierPolicy } from '@/lib/trust/score-tier';

const POLICY: TierPolicy = { autoThreshold: 0.85, reviewThreshold: 0.7, autoMaxCents: 1_000_000 };

function bill(over: Partial<DupBillInput>): DupBillInput {
  return {
    id: 'b1',
    vendorId: 'v1',
    locationId: 'loc1',
    billNumber: null,
    billDate: '2026-03-10',
    totalCents: 500_000,
    paidCents: 0,
    ...over,
  };
}

function vendor(over: Partial<DupVendorInput>): DupVendorInput {
  return {
    id: 'v1',
    name: 'Acme Supply',
    displayName: null,
    email: null,
    tin: null,
    addressLine1: null,
    zip: null,
    spendCents: 0,
    isActive: true,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('normalizeInvoiceNumber', () => {
  it('uppercases and strips non-alphanumerics', () => {
    expect(normalizeInvoiceNumber('inv-2026/0041')).toBe('INV20260041');
    expect(normalizeInvoiceNumber('  #A 12 ')).toBe('A12');
    expect(normalizeInvoiceNumber(null)).toBe('');
  });
});

describe('pairKey', () => {
  it('is order-independent', () => {
    expect(pairKey('dup_bill', 'a', 'b')).toBe('dup_bill:a:b');
    expect(pairKey('dup_bill', 'b', 'a')).toBe('dup_bill:a:b');
  });
});

describe('toConfidence', () => {
  it('clamps into numeric(5,4)', () => {
    expect(toConfidence(0.98)).toBe(0.98);
    expect(toConfidence(1)).toBe(0.9999);
    expect(toConfidence(NaN)).toBe(0);
  });
});

// ── Rule A: duplicate bills ──────────────────────────────────────────────────
describe('scoreDuplicateBills', () => {
  it('flags same invoice number + exact amount at the highest confidence', () => {
    const a = bill({ id: 'a', billNumber: 'INV-100', totalCents: 500_000 });
    const b = bill({ id: 'b', billNumber: 'inv 100', totalCents: 500_000 });
    const sig = scoreDuplicateBills(a, b);
    expect(sig).not.toBeNull();
    expect(sig!.confidence).toBe(0.98);
  });

  it('flags same invoice number even when amounts differ', () => {
    const a = bill({ id: 'a', billNumber: 'INV-100', totalCents: 500_000 });
    const b = bill({ id: 'b', billNumber: 'INV-100', totalCents: 480_000 });
    expect(scoreDuplicateBills(a, b)!.confidence).toBe(0.86);
  });

  it('flags identical amount within the tight date window', () => {
    const a = bill({ id: 'a', billDate: '2026-03-10', totalCents: 500_000 });
    const b = bill({ id: 'b', billDate: '2026-03-13', totalCents: 500_000 });
    expect(scoreDuplicateBills(a, b)!.confidence).toBe(0.92);
  });

  it('downgrades an identical amount that is far apart in date to the wide tier', () => {
    const a = bill({ id: 'a', billDate: '2026-03-01', totalCents: 500_000 });
    const b = bill({ id: 'b', billDate: '2026-04-05', totalCents: 500_000 }); // 35d
    expect(scoreDuplicateBills(a, b)!.confidence).toBe(0.8);
  });

  it('flags a near amount only inside the tight window', () => {
    const a = bill({ id: 'a', billDate: '2026-03-10', totalCents: 500_000 });
    const b = bill({ id: 'b', billDate: '2026-03-12', totalCents: 502_000 }); // 0.4%
    expect(scoreDuplicateBills(a, b)!.confidence).toBe(0.74);
  });

  it('does not flag different vendors', () => {
    const a = bill({ id: 'a', vendorId: 'v1', billNumber: 'INV-100' });
    const b = bill({ id: 'b', vendorId: 'v2', billNumber: 'INV-100' });
    expect(scoreDuplicateBills(a, b)).toBeNull();
  });

  it('does not flag a far-apart, different-amount pair (clean ledger stays quiet)', () => {
    const a = bill({ id: 'a', billDate: '2026-01-05', totalCents: 500_000 });
    const b = bill({ id: 'b', billDate: '2026-06-20', totalCents: 123_400 });
    expect(scoreDuplicateBills(a, b)).toBeNull();
  });

  it('ignores too-short invoice numbers as a match key', () => {
    // Same 2-char "number" but far apart, different amounts → no signal.
    const a = bill({ id: 'a', billNumber: '12', billDate: '2026-01-01', totalCents: 500_000 });
    const b = bill({ id: 'b', billNumber: '12', billDate: '2026-06-01', totalCents: 111_111 });
    expect(scoreDuplicateBills(a, b)).toBeNull();
    expect(DUP_THRESHOLDS.minInvoiceLen).toBe(3);
  });
});

// ── Rule B: duplicate payment against one bill ───────────────────────────────
describe('assessBillPayments', () => {
  it('flags a bill paid twice (two full payments)', () => {
    const pa = assessBillPayments({ totalCents: 500_000 }, { count: 2, paidCents: 1_000_000 });
    expect(pa.isOverpaid).toBe(true);
    expect(pa.overpaidCents).toBe(500_000);
  });

  it('does not flag legitimate partial payments summing to the total', () => {
    const pa = assessBillPayments({ totalCents: 500_000 }, { count: 2, paidCents: 500_000 });
    expect(pa.isOverpaid).toBe(false);
    expect(pa.overpaidCents).toBe(0);
  });

  it('does not flag a single payment even if slightly over (rounding tolerance)', () => {
    const pa = assessBillPayments({ totalCents: 500_000 }, { count: 1, paidCents: 500_100 });
    expect(pa.isOverpaid).toBe(false);
  });
});

// ── Rule C: duplicate vendor masters ─────────────────────────────────────────
describe('scoreDuplicateVendors', () => {
  it('flags matching TIN at the highest confidence', () => {
    const a = vendor({ id: 'v1', name: 'Acme Supply', tin: 'ENC_ABC' });
    const b = vendor({ id: 'v2', name: 'Acme Supplies LLC', tin: 'ENC_ABC' });
    expect(scoreDuplicateVendors(a, b)!.confidence).toBe(0.95);
  });

  it('flags near-identical names + shared email above name-only', () => {
    const a = vendor({ id: 'v1', name: 'Acme Supply Co', email: 'ap@acme.com' });
    const b = vendor({ id: 'v2', name: 'Acme Supply Co', email: 'AP@acme.com' });
    expect(scoreDuplicateVendors(a, b)!.confidence).toBe(0.9);
  });

  it('flags near-identical names without shared contact at the name tier', () => {
    const a = vendor({ id: 'v1', name: 'Acme Supply Company' });
    const b = vendor({ id: 'v2', name: 'Acme Supply Company' });
    expect(scoreDuplicateVendors(a, b)!.confidence).toBe(0.82);
  });

  it('does not flag genuinely different vendors', () => {
    const a = vendor({ id: 'v1', name: 'Acme Supply' });
    const b = vendor({ id: 'v2', name: 'Zenith Roofing' });
    expect(scoreDuplicateVendors(a, b)).toBeNull();
  });

  it('never flags a vendor against itself', () => {
    const a = vendor({ id: 'v1', name: 'Acme Supply', tin: 'ENC_ABC' });
    expect(scoreDuplicateVendors(a, a)).toBeNull();
  });
});

// ── Tiering ──────────────────────────────────────────────────────────────────
describe('resolveDupTier', () => {
  it('always escalates when cash is already out the door', () => {
    expect(resolveDupTier(0.72, 100, POLICY, true)).toBe('escalate');
  });

  it('never lets a high-confidence duplicate auto-suppress — floors to review', () => {
    // 0.98 within cap would be scoreToTier "auto"; a control must still surface.
    expect(resolveDupTier(0.98, 100, POLICY, false)).toBe('review');
  });

  it('escalates a low-confidence hit below the review threshold', () => {
    expect(resolveDupTier(0.5, 100, POLICY, false)).toBe('escalate');
  });

  it('reviews a mid-confidence, in-limits hit', () => {
    expect(resolveDupTier(0.75, 100, POLICY, false)).toBe('review');
  });
});
