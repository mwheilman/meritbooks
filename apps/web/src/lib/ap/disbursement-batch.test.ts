import { describe, it, expect } from 'vitest';
import {
  buildDisbursementBatch,
  scoreIntraBatchDuplicate,
  type DisbursementItemInput,
} from './disbursement-batch';

function item(overrides: Partial<DisbursementItemInput>): DisbursementItemInput {
  return {
    approvalId: 'a1',
    billId: 'b1',
    vendorId: 'v1',
    vendorName: 'Acme Supply',
    invoiceRef: 'INV-100',
    amountCents: 50_000,
    paymentDate: '2026-08-10',
    method: 'ACH',
    locationId: 'loc1',
    preparedBy: 'user_prep',
    ...overrides,
  };
}

describe('buildDisbursementBatch', () => {
  it('groups by vendor with per-vendor and grand totals', () => {
    const batch = buildDisbursementBatch([
      item({ approvalId: 'a1', vendorId: 'v1', vendorName: 'Acme', amountCents: 10_000, invoiceRef: 'A1' }),
      item({ approvalId: 'a2', vendorId: 'v1', vendorName: 'Acme', amountCents: 25_000, invoiceRef: 'A2' }),
      item({ approvalId: 'a3', vendorId: 'v2', vendorName: 'Beta', amountCents: 40_000, invoiceRef: 'B1', method: 'CHECK' }),
    ]);
    expect(batch.controls.itemCount).toBe(3);
    expect(batch.controls.vendorCount).toBe(2);
    expect(batch.controls.totalCents).toBe(75_000);
    const acme = batch.groups.find((g) => g.vendorId === 'v1')!;
    expect(acme.subtotalCents).toBe(35_000);
    expect(acme.itemCount).toBe(2);
    expect(batch.controls.byMethod.ACH.totalCents).toBe(35_000);
    expect(batch.controls.byMethod.CHECK.totalCents).toBe(40_000);
    expect(batch.controls.byMethod.CHECK.count).toBe(1);
  });

  it('sorts vendor groups alphabetically', () => {
    const batch = buildDisbursementBatch([
      item({ approvalId: 'a1', vendorId: 'v1', vendorName: 'Zeta', invoiceRef: 'Z1' }),
      item({ approvalId: 'a2', vendorId: 'v2', vendorName: 'Alpha', invoiceRef: 'A1' }),
    ]);
    expect(batch.groups.map((g) => g.vendorName)).toEqual(['Alpha', 'Zeta']);
  });

  it('flags a critical duplicate (same invoice + same amount) and blocks', () => {
    const batch = buildDisbursementBatch([
      item({ approvalId: 'a1', invoiceRef: 'INV-500', amountCents: 30_000 }),
      item({ approvalId: 'a2', invoiceRef: 'INV-500', amountCents: 30_000 }),
    ]);
    expect(batch.duplicateWarnings).toHaveLength(1);
    expect(batch.duplicateWarnings[0].severity).toBe('critical');
    expect(batch.controls.hasBlockingDuplicates).toBe(true);
    // both lines cross-reference each other
    const ids = batch.groups[0].items.map((i) => i.duplicateOf.sort());
    expect(ids).toEqual([['a2'], ['a1']]);
  });

  it('does not flag different invoices at different amounts', () => {
    const batch = buildDisbursementBatch([
      item({ approvalId: 'a1', invoiceRef: 'INV-1', amountCents: 10_000 }),
      item({ approvalId: 'a2', invoiceRef: 'INV-2', amountCents: 99_999 }),
    ]);
    expect(batch.duplicateWarnings).toHaveLength(0);
    expect(batch.controls.hasBlockingDuplicates).toBe(false);
  });

  it('does not cross-flag duplicates across different vendors', () => {
    const batch = buildDisbursementBatch([
      item({ approvalId: 'a1', vendorId: 'v1', vendorName: 'Acme', invoiceRef: 'SAME', amountCents: 30_000 }),
      item({ approvalId: 'a2', vendorId: 'v2', vendorName: 'Beta', invoiceRef: 'SAME', amountCents: 30_000 }),
    ]);
    expect(batch.duplicateWarnings).toHaveLength(0);
  });

  it('throws on a non-positive amount (money invariant)', () => {
    expect(() => buildDisbursementBatch([item({ amountCents: 0 })])).toThrow();
    expect(() => buildDisbursementBatch([item({ amountCents: -5 })])).toThrow();
  });
});

describe('scoreIntraBatchDuplicate', () => {
  it('returns null for the same approval id', () => {
    const a = item({ approvalId: 'x' });
    expect(scoreIntraBatchDuplicate(a, a)).toBeNull();
  });
  it('scores identical amount within tight days highly', () => {
    const sig = scoreIntraBatchDuplicate(
      item({ approvalId: 'a1', invoiceRef: null, amountCents: 12_345, paymentDate: '2026-08-01' }),
      item({ approvalId: 'a2', invoiceRef: null, amountCents: 12_345, paymentDate: '2026-08-03' }),
    );
    expect(sig).not.toBeNull();
    expect(sig!.confidence).toBeGreaterThanOrEqual(0.9);
  });
});
