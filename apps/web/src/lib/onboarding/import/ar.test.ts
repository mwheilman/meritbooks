/**
 * Customers & Open A/R onboarding — pure normalizer / dedupe / subledger-total tests.
 *
 * These pin the load-bearing rules the section relies on:
 *   • normalization (money cents, paid→balance, ERP-provider adapters)
 *   • dedupe (collapse duplicate masters; match against existing; synthesize a master
 *     for an invoice party with no customer row so no invoice is ever dropped)
 *   • Σ open A/R (what foots to the 1100 control) — excludes duplicates & fully-paid.
 *
 * Pure logic only — no Supabase, no Date.now.
 */

import { describe, it, expect } from 'vitest';
import {
  buildArProposal,
  sumOpenArCents,
  validateArProposal,
  normalizeArOpenItem,
  arOpenItemFromProvider,
  customerNameKey,
  type RawArParty,
  type RawArOpenItem,
} from './ar';
import type { ProviderOpenItem } from '@/lib/integrations/erp/providers/types';

const parties: RawArParty[] = [
  { name: 'Acme Co', email: 'ap@acme.com' },
  { name: 'ACME  CO.', email: 'dup@acme.com' }, // same normalized name → collapses
  { name: 'Beta LLC' },
];

const openItems: RawArOpenItem[] = [
  { partyName: 'Acme Co', docNumber: 'INV-1', date: '2026-01-01', dueDate: '2026-01-31', totalCents: 100_00, amountPaidCents: 0 },
  { partyName: 'Beta LLC', docNumber: 'INV-2', date: '2026-01-05', dueDate: '2026-02-04', totalCents: 250_00, amountPaidCents: 50_00 }, // balance 200.00
  { partyName: 'Gamma Inc', docNumber: 'INV-3', date: '2026-01-06', dueDate: '2026-02-05', totalCents: 400_00, amountPaidCents: 400_00 }, // fully paid → not open
  { partyName: 'Zeta Corp', docNumber: 'INV-4', date: '2026-01-07', dueDate: '2026-02-06', totalCents: 75_00 }, // party has NO customer row
];

describe('buildArProposal', () => {
  const proposal = buildArProposal({
    source: 'csv',
    parties,
    openItems,
    existingCustomerKeys: new Set<string>(),
    existingInvoiceNumbers: new Set<string>(),
  });

  it('collapses duplicate masters by normalized name', () => {
    // Acme Co + "ACME  CO." collapse to one; Beta, Gamma (from invoice), Zeta (from invoice) added.
    const names = proposal.customers.map((c) => c.name);
    const acme = names.filter((n) => customerNameKey(n) === customerNameKey('Acme Co'));
    expect(acme).toHaveLength(1);
  });

  it('synthesizes a master for an invoice party with no customer row (no invoice dropped)', () => {
    const zeta = proposal.customers.find((c) => c.name === 'Zeta Corp');
    expect(zeta).toBeDefined();
    expect(zeta?.fromInvoice).toBe(true);
    // Every open invoice's customer resolves within the proposed master list.
    for (const inv of proposal.invoices) {
      expect(proposal.customers.some((c) => customerNameKey(c.name) === customerNameKey(inv.customerName))).toBe(true);
    }
  });

  it('sums Σ open A/R excluding fully-paid items (100.00 + 200.00 + 75.00 = 375.00)', () => {
    expect(proposal.openArCents).toBe(375_00);
    expect(sumOpenArCents(proposal.invoices)).toBe(375_00);
  });

  it('flags an invoice already present in the ledger as a duplicate and excludes it from Σ', () => {
    const withDupe = buildArProposal({
      source: 'csv',
      parties,
      openItems,
      existingCustomerKeys: new Set<string>(),
      existingInvoiceNumbers: new Set(['inv-1']), // INV-1 already exists
    });
    const inv1 = withDupe.invoices.find((i) => i.invoiceNumber === 'INV-1');
    expect(inv1?.duplicate).toBe(true);
    expect(withDupe.openArCents).toBe(275_00); // 375.00 − 100.00
  });

  it('marks existing customers as matched, not new', () => {
    const withExisting = buildArProposal({
      source: 'manual',
      parties,
      openItems: [],
      existingCustomerKeys: new Set([customerNameKey('Beta LLC')]),
      existingInvoiceNumbers: new Set<string>(),
    });
    const beta = withExisting.customers.find((c) => c.name === 'Beta LLC');
    expect(beta?.existing).toBe(true);
    expect(withExisting.matchedCustomers).toBe(1);
  });
});

describe('normalizeArOpenItem + provider adapter', () => {
  it('derives balance = total − paid and clamps negatives', () => {
    const d = normalizeArOpenItem({ partyName: 'X', docNumber: 'A', date: '2026-01-01', dueDate: '2026-02-01', totalCents: 500, amountPaidCents: 700 }, false);
    expect(d.amountPaidCents).toBe(700);
    expect(d.balanceCents).toBe(-200); // caught by validate, not silently corrupted
  });

  it('maps a ProviderOpenItem (total + remaining balance) to paid = total − balance', () => {
    const p: ProviderOpenItem = { partyName: 'X', docNumber: 'A', date: '2026-01-01', dueDate: '2026-02-01', totalCents: 1000, balanceCents: 300 };
    const raw = arOpenItemFromProvider(p);
    expect(raw.amountPaidCents).toBe(700);
    expect(normalizeArOpenItem(raw, false).balanceCents).toBe(300);
  });
});

describe('validateArProposal', () => {
  it('blocks when an invoice shows more paid than its total', () => {
    const proposal = buildArProposal({
      source: 'manual',
      parties: [{ name: 'X' }],
      openItems: [{ partyName: 'X', docNumber: 'A', date: '2026-01-01', dueDate: '2026-02-01', totalCents: 100, amountPaidCents: 200 }],
      existingCustomerKeys: new Set<string>(),
      existingInvoiceNumbers: new Set<string>(),
    });
    expect(validateArProposal(proposal).length).toBeGreaterThan(0);
  });

  it('passes a clean proposal', () => {
    const proposal = buildArProposal({
      source: 'manual',
      parties: [{ name: 'X' }],
      openItems: [{ partyName: 'X', docNumber: 'A', date: '2026-01-01', dueDate: '2026-02-01', totalCents: 100, amountPaidCents: 0 }],
      existingCustomerKeys: new Set<string>(),
      existingInvoiceNumbers: new Set<string>(),
    });
    expect(validateArProposal(proposal)).toEqual([]);
  });
});
