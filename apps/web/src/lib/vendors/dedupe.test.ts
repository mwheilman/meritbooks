/**
 * Vendor duplicate-detection matching logic — locks the scorer's rules and
 * thresholds. Change a cut-line and the drawer's surfaced "possible duplicates"
 * (and their ordering) shift, so these assertions pin the documented behavior.
 *
 * Pure logic only — no Supabase, no Date.now. Mirrors lib/customers/dedupe.test
 * minus the tax-id rule (core.vendors has no plaintext TIN).
 */

import { describe, it, expect } from 'vitest';
import {
  scoreVendorDuplicates,
  pairsForVendor,
  allCandidatePairs,
  normalizePhone,
  pairKey,
  toConfidence,
  VENDOR_DUP_THRESHOLDS,
  type VendorDupInput,
} from './dedupe';

function ven(over: Partial<VendorDupInput> & { id: string; name: string }): VendorDupInput {
  return {
    displayName: null,
    email: null,
    phone: null,
    addressLine1: null,
    zip: null,
    openApCents: 0,
    ...over,
  };
}

describe('normalizers', () => {
  it('normalizePhone keeps the last 10 digits', () => {
    expect(normalizePhone('(515) 555-0100')).toBe('5155550100');
    expect(normalizePhone('+1 515 555 0100')).toBe('5155550100');
    expect(normalizePhone('555-0100')).toBe('5550100'); // < 10 digits, returned as-is
  });

  it('pairKey is order-independent', () => {
    expect(pairKey('vendordedupe', 'b', 'a')).toBe(pairKey('vendordedupe', 'a', 'b'));
  });

  it('toConfidence clamps into numeric(5,4)', () => {
    expect(toConfidence(1.5)).toBe(0.9999);
    expect(toConfidence(-1)).toBe(0);
    expect(toConfidence(0.9235)).toBe(0.9235);
  });
});

describe('scoreVendorDuplicates', () => {
  it('returns null for the same id', () => {
    expect(scoreVendorDuplicates(ven({ id: 'x', name: 'Acme' }), ven({ id: 'x', name: 'Acme' }))).toBeNull();
  });

  it('near-identical name + shared email scores 0.93', () => {
    const a = ven({ id: 'a', name: 'Riverside Supply', email: 'ap@riverside.com' });
    const b = ven({ id: 'b', name: 'Riverside Supply LLC', email: 'AP@Riverside.com' });
    const sig = scoreVendorDuplicates(a, b);
    expect(sig!.confidence).toBe(0.93);
    expect(sig!.matchedFields).toEqual(['name', 'email']);
  });

  it('shared email + moderately related names (name not strong) surfaces at 0.90', () => {
    const a = ven({ id: 'a', name: 'Riverside North Supply', email: 'billing@riverside.com' });
    const b = ven({ id: 'b', name: 'Riverside Supply', email: 'billing@riverside.com' });
    const sig = scoreVendorDuplicates(a, b);
    expect(sig!.confidence).toBe(0.9);
    expect(sig!.matchedFields).toContain('email');
  });

  it('shared phone + moderately related names scores 0.86', () => {
    const a = ven({ id: 'a', name: 'Cedar North Lumber', phone: '(515) 555-0100' });
    const b = ven({ id: 'b', name: 'Cedar Lumber', phone: '515-555-0100' });
    const sig = scoreVendorDuplicates(a, b);
    expect(sig!.confidence).toBe(0.86);
    expect(sig!.matchedFields).toContain('phone');
  });

  it('near-identical name alone scores 0.82', () => {
    const a = ven({ id: 'a', name: 'Summit Electric' });
    const b = ven({ id: 'b', name: 'Summit Electric Inc' });
    const sig = scoreVendorDuplicates(a, b);
    expect(sig!.confidence).toBe(0.82);
    expect(sig!.matchedFields).toEqual(['name']);
  });

  it('unrelated vendors score null (below floor)', () => {
    const a = ven({ id: 'a', name: 'Acme Plumbing', email: 'a@acme.com' });
    const b = ven({ id: 'b', name: 'Zenith Roofing', email: 'z@zenith.com' });
    expect(scoreVendorDuplicates(a, b)).toBeNull();
  });
});

describe('pairsForVendor / allCandidatePairs', () => {
  const roster = [
    ven({ id: 'a', name: 'Riverside Supply', email: 'ap@riverside.com', openApCents: 500000 }),
    ven({ id: 'b', name: 'Riverside Supply LLC', email: 'ap@riverside.com', openApCents: 200000 }),
    ven({ id: 'c', name: 'Completely Different Co', email: 'x@diff.com', openApCents: 10000 }),
  ];

  it('pairsForVendor returns the duplicate, sorted, with at-risk = smaller open A/P', () => {
    const pairs = pairsForVendor(roster[0], [roster[1], roster[2]]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].b.id).toBe('b');
    expect(pairs[0].amountAtRiskCents).toBe(200000); // min(500000, 200000)
  });

  it('allCandidatePairs de-duplicates a pair reached via two buckets', () => {
    const pairs = allCandidatePairs(roster);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].dedupKey).toBe(pairKey('vendordedupe', 'a', 'b'));
  });

  it('every surfaced pair is at or above the minSurface floor', () => {
    for (const p of allCandidatePairs(roster)) {
      expect(p.signal.confidence).toBeGreaterThanOrEqual(VENDOR_DUP_THRESHOLDS.minSurface);
    }
  });
});
