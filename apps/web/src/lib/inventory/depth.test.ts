import { describe, it, expect } from 'vitest';
import { resolveMovementRef } from './inventory-service';
import { isBelowReorder, buildReorderCandidate, reorderDedupKey } from './reorder-detector';
import { deriveReceiptFromBillLine } from './receipt-links';

describe('resolveMovementRef (issue-to-job/invoice linkage)', () => {
  it('a job wins over everything and becomes ref_type JOB', () => {
    const ref = resolveMovementRef({ jobId: 'job-1', invoiceId: 'inv-1', invoiceLineId: 'il-1' }, 'note');
    expect(ref.refType).toBe('JOB');
    expect(ref.refId).toBe('job-1');
    expect(ref.reference).toBe('note');
  });

  it('an invoice line ties into reference when no job is given', () => {
    const ref = resolveMovementRef({ invoiceId: 'inv-1', invoiceLineId: 'il-9' });
    expect(ref.refType).toBe('INVOICE');
    expect(ref.refId).toBe('inv-1');
    expect(ref.reference).toBe('il-9');
  });

  it('an invoice without a line keeps the free-text reference', () => {
    const ref = resolveMovementRef({ invoiceId: 'inv-1' }, 'ship-42');
    expect(ref.refType).toBe('INVOICE');
    expect(ref.reference).toBe('ship-42');
  });

  it('no linkage is MANUAL with a null ref_id', () => {
    const ref = resolveMovementRef({});
    expect(ref.refType).toBe('MANUAL');
    expect(ref.refId).toBeNull();
  });
});

describe('reorder detection', () => {
  it('at or below the point is low; above is not; null point never fires', () => {
    expect(isBelowReorder(5, 10)).toBe(true);
    expect(isBelowReorder(10, 10)).toBe(true); // at the point is low
    expect(isBelowReorder(11, 10)).toBe(false);
    expect(isBelowReorder(0, 10)).toBe(true);
    expect(isBelowReorder(5, null)).toBe(false);
    expect(isBelowReorder(5, undefined)).toBe(false);
  });

  const base = {
    id: 'item-1',
    sku: 'SKU1',
    name: 'Widget',
    uom: 'each',
    avg_cost_cents: 250,
    location_id: null,
    is_active: true,
  };

  it('builds a low-stock candidate with a stable dedup key and shortfall value', () => {
    const c = buildReorderCandidate({ ...base, qty_on_hand: 4, reorder_point: 10 });
    expect(c).not.toBeNull();
    expect(c!.dedupKey).toBe(reorderDedupKey('item-1'));
    expect(c!.stockout).toBe(false);
    // shortfall 6 units × 250c
    expect(c!.shortfallValueCents).toBe(1500);
  });

  it('flags a stockout when on-hand is zero or negative', () => {
    const c = buildReorderCandidate({ ...base, qty_on_hand: 0, reorder_point: 10 });
    expect(c!.stockout).toBe(true);
  });

  it('returns null when above the point or inactive', () => {
    expect(buildReorderCandidate({ ...base, qty_on_hand: 20, reorder_point: 10 })).toBeNull();
    expect(buildReorderCandidate({ ...base, qty_on_hand: 1, reorder_point: 10, is_active: false })).toBeNull();
    expect(buildReorderCandidate({ ...base, qty_on_hand: 1, reorder_point: null })).toBeNull();
  });
});

describe('deriveReceiptFromBillLine', () => {
  it('prefers the extended amount over qty × unit', () => {
    const r = deriveReceiptFromBillLine({ quantity: 3, unitCostCents: 100, amountCents: 305 });
    expect(r).toEqual({ qty: 3, totalCostCents: 305 });
  });

  it('falls back to qty × unit when no extended amount', () => {
    const r = deriveReceiptFromBillLine({ quantity: 4, unitCostCents: 125, amountCents: 0 });
    expect(r).toEqual({ qty: 4, totalCostCents: 500 });
  });

  it('returns null for a non-positive quantity', () => {
    expect(deriveReceiptFromBillLine({ quantity: 0, unitCostCents: 100, amountCents: 0 })).toBeNull();
    expect(deriveReceiptFromBillLine({ quantity: -2, unitCostCents: 100, amountCents: 200 })).toBeNull();
  });
});
