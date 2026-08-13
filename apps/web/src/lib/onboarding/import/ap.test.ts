/**
 * Vendors & Open A/P onboarding — pure normalizer / dedupe / subledger-total tests.
 * Payables mirror of ar.test.ts. Pure logic only — no Supabase, no Date.now.
 */

import { describe, it, expect } from 'vitest';
import {
  buildApProposal,
  sumOpenApCents,
  validateApProposal,
  billKey,
  vendorNameKey,
  apOpenItemFromProvider,
  normalizeApOpenItem,
  type RawApParty,
  type RawApOpenItem,
} from './ap';
import type { ProviderOpenItem } from '@/lib/integrations/erp/providers/types';

const parties: RawApParty[] = [
  { name: 'Steel Supply', email: 'ar@steel.com' },
  { name: 'STEEL   supply', email: 'dup@steel.com' }, // collapses
  { name: 'Nail Co' },
];

const openItems: RawApOpenItem[] = [
  { partyName: 'Steel Supply', docNumber: 'B-1', date: '2026-01-01', dueDate: '2026-01-31', totalCents: 300_00, amountPaidCents: 0 },
  { partyName: 'Nail Co', docNumber: 'B-2', date: '2026-01-05', dueDate: '2026-02-04', totalCents: 100_00, amountPaidCents: 40_00 }, // balance 60.00
  { partyName: 'Paint Pros', docNumber: '', date: '2026-01-06', dueDate: '2026-02-05', totalCents: 90_00 }, // no bill number; party has no vendor row
];

describe('buildApProposal', () => {
  const proposal = buildApProposal({
    source: 'csv',
    parties,
    openItems,
    existingVendorKeys: new Set<string>(),
    existingBillKeys: new Set<string>(),
  });

  it('collapses duplicate vendor masters and synthesizes one for a billed party with no row', () => {
    const steel = proposal.vendors.filter((v) => vendorNameKey(v.name) === vendorNameKey('Steel Supply'));
    expect(steel).toHaveLength(1);
    const paint = proposal.vendors.find((v) => v.name === 'Paint Pros');
    expect(paint?.fromBill).toBe(true);
  });

  it('sums Σ open A/P (300.00 + 60.00 + 90.00 = 450.00)', () => {
    expect(proposal.openApCents).toBe(450_00);
    expect(sumOpenApCents(proposal.bills)).toBe(450_00);
  });

  it('dedupes a bill already in the ledger by (vendor, number) key and excludes it from Σ', () => {
    const existing = new Set([billKey(vendorNameKey('Steel Supply'), 'B-1', 300_00, '2026-01-01')]);
    const withDupe = buildApProposal({
      source: 'csv',
      parties,
      openItems,
      existingVendorKeys: new Set<string>(),
      existingBillKeys: existing,
    });
    expect(withDupe.bills.find((b) => b.billNumber === 'B-1')?.duplicate).toBe(true);
    expect(withDupe.openApCents).toBe(150_00); // 450.00 − 300.00
  });
});

describe('apOpenItemFromProvider', () => {
  it('maps total + remaining balance to paid = total − balance', () => {
    const p: ProviderOpenItem = { partyName: 'V', docNumber: 'B', date: '2026-01-01', dueDate: '2026-02-01', totalCents: 800, balanceCents: 500 };
    const raw = apOpenItemFromProvider(p);
    expect(raw.amountPaidCents).toBe(300);
    expect(normalizeApOpenItem(raw, false).balanceCents).toBe(500);
  });
});

describe('validateApProposal', () => {
  it('blocks when a bill shows more paid than its total', () => {
    const proposal = buildApProposal({
      source: 'manual',
      parties: [{ name: 'V' }],
      openItems: [{ partyName: 'V', docNumber: 'B', date: '2026-01-01', dueDate: '2026-02-01', totalCents: 100, amountPaidCents: 200 }],
      existingVendorKeys: new Set<string>(),
      existingBillKeys: new Set<string>(),
    });
    expect(validateApProposal(proposal).length).toBeGreaterThan(0);
  });
});
