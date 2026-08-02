/**
 * Customer duplicate-detection matching logic — locks the scorer's rules and
 * thresholds. Change a cut-line and every queued CUSTOMER_DEDUPE proposal (and
 * its tier) shifts, so these assertions pin the documented behavior.
 *
 * Pure logic only — no Supabase, no Date.now.
 */

import { describe, it, expect } from 'vitest';
import {
  scoreCustomerDuplicates,
  pairsForCustomer,
  allCandidatePairs,
  normalizeTaxId,
  normalizePhone,
  pairKey,
  toConfidence,
  CUST_DUP_THRESHOLDS,
  type CustomerDupInput,
} from './dedupe';

function cust(over: Partial<CustomerDupInput> & { id: string; name: string }): CustomerDupInput {
  return {
    displayName: null,
    email: null,
    phone: null,
    taxId: null,
    addressLine1: null,
    zip: null,
    openArCents: 0,
    ...over,
  };
}

describe('normalizers', () => {
  it('normalizeTaxId strips punctuation and upper-cases', () => {
    expect(normalizeTaxId('12-3456789')).toBe('123456789');
    expect(normalizeTaxId(' ab-12 ')).toBe('AB12');
    expect(normalizeTaxId(null)).toBe('');
  });

  it('normalizePhone keeps the last 10 digits', () => {
    expect(normalizePhone('(515) 555-0100')).toBe('5155550100');
    expect(normalizePhone('+1 515 555 0100')).toBe('5155550100');
    expect(normalizePhone('555-0100')).toBe('5550100'); // < 10 digits, returned as-is
  });

  it('pairKey is order-independent', () => {
    expect(pairKey('custdedupe', 'b', 'a')).toBe(pairKey('custdedupe', 'a', 'b'));
  });

  it('toConfidence clamps into numeric(5,4)', () => {
    expect(toConfidence(1.5)).toBe(0.9999);
    expect(toConfidence(-1)).toBe(0);
    expect(toConfidence(0.9235)).toBe(0.9235);
  });
});

describe('scoreCustomerDuplicates', () => {
  it('returns null for the same id', () => {
    expect(scoreCustomerDuplicates(cust({ id: 'x', name: 'Acme' }), cust({ id: 'x', name: 'Acme' }))).toBeNull();
  });

  it('matching tax ID is the top signal (0.96) and records tax_id', () => {
    const a = cust({ id: 'a', name: 'Acme Corp', taxId: '12-3456789' });
    const b = cust({ id: 'b', name: 'Acme Corporation', taxId: '123456789' });
    const sig = scoreCustomerDuplicates(a, b);
    expect(sig).not.toBeNull();
    expect(sig!.confidence).toBe(0.96);
    expect(sig!.matchedFields).toContain('tax_id');
  });

  it('near-identical name + shared email scores 0.93', () => {
    const a = cust({ id: 'a', name: 'Riverside Builders', email: 'ap@riverside.com' });
    const b = cust({ id: 'b', name: 'Riverside Builders LLC', email: 'AP@Riverside.com' });
    const sig = scoreCustomerDuplicates(a, b);
    expect(sig!.confidence).toBe(0.93);
    expect(sig!.matchedFields).toEqual(['name', 'email']);
  });

  it('shared email + moderately related names (name not strong) surfaces at 0.90', () => {
    // Reordered tokens keep name similarity at ~0.85 (near, not strong), so the
    // email rule wins rather than the strong-name+contact rule.
    const a = cust({ id: 'a', name: 'Riverside North Builders', email: 'billing@riverside.com' });
    const b = cust({ id: 'b', name: 'Riverside Builders', email: 'billing@riverside.com' });
    const sig = scoreCustomerDuplicates(a, b);
    expect(sig!.confidence).toBe(0.9);
    expect(sig!.matchedFields).toContain('email');
  });

  it('shared phone + moderately related names scores 0.86', () => {
    const a = cust({ id: 'a', name: 'Cedar North Homes', phone: '(515) 555-0100' });
    const b = cust({ id: 'b', name: 'Cedar Homes', phone: '515-555-0100' });
    const sig = scoreCustomerDuplicates(a, b);
    expect(sig!.confidence).toBe(0.86);
    expect(sig!.matchedFields).toContain('phone');
  });

  it('near-identical name alone scores 0.82', () => {
    const a = cust({ id: 'a', name: 'Summit Builders' });
    const b = cust({ id: 'b', name: 'Summit Builders Inc' });
    const sig = scoreCustomerDuplicates(a, b);
    expect(sig!.confidence).toBe(0.82);
    expect(sig!.matchedFields).toEqual(['name']);
  });

  it('unrelated customers score null (below floor)', () => {
    const a = cust({ id: 'a', name: 'Acme Plumbing', email: 'a@acme.com' });
    const b = cust({ id: 'b', name: 'Zenith Roofing', email: 'z@zenith.com' });
    expect(scoreCustomerDuplicates(a, b)).toBeNull();
  });

  it('short/blank tax IDs do not count as a match', () => {
    const a = cust({ id: 'a', name: 'Alpha', taxId: '12' });
    const b = cust({ id: 'b', name: 'Bravo', taxId: '12' });
    // tax match ignored (< minTaxIdLen) and names differ → null
    expect(scoreCustomerDuplicates(a, b)).toBeNull();
    expect(CUST_DUP_THRESHOLDS.minTaxIdLen).toBeGreaterThan(2);
  });
});

describe('pairsForCustomer / allCandidatePairs', () => {
  const roster = [
    cust({ id: 'a', name: 'Riverside Builders', email: 'ap@riverside.com', openArCents: 500000 }),
    cust({ id: 'b', name: 'Riverside Builders LLC', email: 'ap@riverside.com', openArCents: 200000 }),
    cust({ id: 'c', name: 'Completely Different Co', email: 'x@diff.com', openArCents: 10000 }),
  ];

  it('pairsForCustomer returns the duplicate, sorted, with at-risk = smaller open AR', () => {
    const pairs = pairsForCustomer(roster[0], [roster[1], roster[2]]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].b.id).toBe('b');
    expect(pairs[0].amountAtRiskCents).toBe(200000); // min(500000, 200000)
  });

  it('allCandidatePairs de-duplicates a pair reached via two buckets', () => {
    const pairs = allCandidatePairs(roster);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].dedupKey).toBe(pairKey('custdedupe', 'a', 'b'));
  });

  it('every surfaced pair is at or above the minSurface floor', () => {
    for (const p of allCandidatePairs(roster)) {
      expect(p.signal.confidence).toBeGreaterThanOrEqual(CUST_DUP_THRESHOLDS.minSurface);
    }
  });
});
