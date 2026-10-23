/** Security review M3 — the disbursement export leaves held vendors out (pure split). */
import { describe, it, expect } from 'vitest';
import { heldSummary, splitHeld } from './assemble-batch';
import type { DisbursementItemInput } from './disbursement-batch';

const item = (over: Partial<DisbursementItemInput>): DisbursementItemInput => ({
  approvalId: 'a', billId: 'b', vendorId: 'v', vendorName: 'Acme', invoiceRef: 'INV-1', amountCents: 100,
  paymentDate: '2026-10-23', method: 'ACH', locationId: 'L', preparedBy: 'p', ...over,
});

describe('splitHeld', () => {
  it('moves a held vendor+bill out with its reason; keeps the rest', () => {
    const items = [item({ approvalId: 'a1', billId: 'b1', vendorId: 'v1' }), item({ approvalId: 'a2', billId: 'b2', vendorId: 'v2', vendorName: 'Fraud Co' })];
    const { kept, held } = splitHeld(items, new Map([['v2|b2', 'Bank details changed — call back first.']]));
    expect(kept.map((k) => k.approvalId)).toEqual(['a1']);
    expect(held).toEqual([expect.objectContaining({ approvalId: 'a2', vendorName: 'Fraud Co', reason: 'Bank details changed — call back first.' })]);
    expect(heldSummary(held)).toMatch(/1 payment\(s\) left out.*Fraud Co/);
    expect(heldSummary([])).toBe('');
  });
});
