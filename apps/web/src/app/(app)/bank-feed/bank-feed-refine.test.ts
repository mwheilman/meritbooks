import { describe, it, expect } from 'vitest';
import type { BankFeedRow } from '@meritbooks/shared';
import {
  confidenceBandOf,
  matchesBand,
  vendorLabelOf,
  distinctVendors,
  filterByRefine,
  selectionTotals,
  idsInBand,
} from './bank-feed-refine';

/** Minimal row factory — only the fields the refine helpers read. */
function row(partial: Partial<BankFeedRow> & { id: string }): BankFeedRow {
  return {
    id: partial.id,
    transaction_date: '2026-01-15',
    description: partial.description ?? 'TXN',
    amount_cents: partial.amount_cents ?? -1000,
    status: 'PENDING',
    ai_confidence: partial.ai_confidence ?? null,
    ai_reasoning: null,
    match_type: null,
    match_confidence: null,
    matched_bill_id: null,
    matched_receipt_id: null,
    location: null,
    ai_account: null,
    ai_vendor: partial.ai_vendor ?? null,
    final_account: null,
    final_job: null,
    matched_bill: null,
  } as BankFeedRow;
}

describe('confidenceBandOf', () => {
  it('classifies by the documented 90/70 cutoffs, null → uncoded', () => {
    expect(confidenceBandOf(0.95)).toBe('high');
    expect(confidenceBandOf(0.9)).toBe('high'); // boundary inclusive
    expect(confidenceBandOf(0.89)).toBe('medium');
    expect(confidenceBandOf(0.7)).toBe('medium'); // boundary inclusive
    expect(confidenceBandOf(0.69)).toBe('low');
    expect(confidenceBandOf(0)).toBe('low');
    expect(confidenceBandOf(null)).toBe('uncoded');
    expect(confidenceBandOf(undefined)).toBe('uncoded');
  });
});

describe('matchesBand', () => {
  it('all matches everything; specific bands gate correctly', () => {
    const r = row({ id: '1', ai_confidence: 0.5 });
    expect(matchesBand(r, 'all')).toBe(true);
    expect(matchesBand(r, 'low')).toBe(true);
    expect(matchesBand(r, 'high')).toBe(false);
  });
});

describe('vendorLabelOf / distinctVendors', () => {
  it('prefers display_name and returns a sorted, de-duplicated set', () => {
    const rows = [
      row({ id: '1', ai_vendor: { id: 'v1', name: 'amazon', display_name: 'Amazon' } }),
      row({ id: '2', ai_vendor: { id: 'v1', name: 'amazon', display_name: 'Amazon' } }),
      row({ id: '3', ai_vendor: { id: 'v2', name: 'Home Depot', display_name: null } }),
      row({ id: '4', ai_vendor: null }),
    ];
    expect(vendorLabelOf(rows[0])).toBe('Amazon');
    expect(vendorLabelOf(rows[2])).toBe('Home Depot');
    expect(distinctVendors(rows)).toEqual(['Amazon', 'Home Depot']);
  });
});

describe('filterByRefine', () => {
  const rows = [
    row({ id: 'h', ai_confidence: 0.95, ai_vendor: { id: 'v1', name: 'a', display_name: 'Acme' } }),
    row({ id: 'm', ai_confidence: 0.8, ai_vendor: { id: 'v2', name: 'b', display_name: 'Beta' } }),
    row({ id: 'l', ai_confidence: 0.4, ai_vendor: { id: 'v1', name: 'a', display_name: 'Acme' } }),
    row({ id: 'u', ai_confidence: null, ai_vendor: null }),
  ];

  it('returns the same array reference when no filter is active', () => {
    expect(filterByRefine(rows, { band: 'all', vendor: null })).toBe(rows);
  });

  it('narrows by band and preserves order', () => {
    expect(filterByRefine(rows, { band: 'low', vendor: null }).map((r) => r.id)).toEqual(['l']);
    expect(filterByRefine(rows, { band: 'uncoded', vendor: null }).map((r) => r.id)).toEqual(['u']);
  });

  it('narrows by band AND vendor together', () => {
    expect(
      filterByRefine(rows, { band: 'high', vendor: 'Acme' }).map((r) => r.id),
    ).toEqual(['h']);
    expect(filterByRefine(rows, { band: 'medium', vendor: 'Acme' })).toHaveLength(0);
  });
});

describe('selectionTotals', () => {
  it('counts and sums ABSOLUTE cents of only the visible + selected rows', () => {
    const rows = [
      row({ id: '1', amount_cents: -2500 }),
      row({ id: '2', amount_cents: 4000 }),
      row({ id: '3', amount_cents: -1000 }),
    ];
    const selected = new Set(['1', '2', 'not-visible']);
    const t = selectionTotals(rows, selected);
    expect(t.count).toBe(2);
    expect(t.totalCents).toBe(6500); // |−2500| + |4000|
  });

  it('is zero for an empty selection', () => {
    expect(selectionTotals([row({ id: '1' })], new Set())).toEqual({ count: 0, totalCents: 0 });
  });
});

describe('idsInBand', () => {
  it('returns ids of visible rows in the given band', () => {
    const rows = [
      row({ id: 'h1', ai_confidence: 0.99 }),
      row({ id: 'h2', ai_confidence: 0.91 }),
      row({ id: 'l1', ai_confidence: 0.2 }),
    ];
    expect(idsInBand(rows, 'high').sort()).toEqual(['h1', 'h2']);
    expect(idsInBand(rows, 'low')).toEqual(['l1']);
    expect(idsInBand(rows, 'medium')).toEqual([]);
  });
});
