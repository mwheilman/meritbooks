import { describe, it, expect } from 'vitest';
import {
  computeBorrowingBase,
  daysPastDue,
  type ArInvoiceInput,
} from './calc';

const AS_OF = '2026-08-01';

function inv(customerId: string, customerName: string, balanceCents: number, dueDate: string | null): ArInvoiceInput {
  return { customerId, customerName, balanceCents, dueDate };
}

describe('daysPastDue', () => {
  it('is positive when the due date is in the past and 0 for a null due date', () => {
    expect(daysPastDue('2026-07-01', AS_OF)).toBe(31);
    expect(daysPastDue('2026-09-01', AS_OF)).toBe(-31); // not yet due
    expect(daysPastDue(null, AS_OF)).toBe(0);
  });
});

describe('computeBorrowingBase — advance-rate application', () => {
  it('applies the AR advance rate to eligible AR (concentration disabled)', () => {
    const r = computeBorrowingBase(
      { arInvoices: [inv('c1', 'Acme', 100_000, '2026-07-15')], inventoryValueCents: 0, asOf: AS_OF },
      { concentrationCapPct: 0 }, // default 80% AR rate otherwise
    );
    expect(r.grossArCents).toBe(100_000);
    expect(r.arPastDueIneligibleCents).toBe(0);
    expect(r.eligibleArCents).toBe(100_000);
    expect(r.arAdvanceRate).toBe(0.8);
    expect(r.arAvailabilityCents).toBe(80_000); // 100000 * 0.80
    expect(r.borrowingBaseCents).toBe(80_000);
    expect(r.availabilityCents).toBe(80_000);
  });
});

describe('computeBorrowingBase — ineligible carve-outs', () => {
  it('carves out invoices past the aging cutoff', () => {
    const r = computeBorrowingBase(
      {
        arInvoices: [
          inv('c1', 'Acme', 100_000, '2026-07-02'), // 30 days past → eligible
          inv('c1', 'Acme', 50_000, '2026-03-01'), // >90 days past → ineligible
        ],
        inventoryValueCents: 0,
        asOf: AS_OF,
      },
      { concentrationCapPct: 0 },
    );
    expect(r.grossArCents).toBe(150_000);
    expect(r.arPastDueIneligibleCents).toBe(50_000);
    expect(r.arCrossAgeIneligibleCents).toBe(0);
    expect(r.eligibleArCents).toBe(100_000);
    expect(r.arAvailabilityCents).toBe(80_000);
  });

  it('cross-age taint makes the entire tainted customer ineligible', () => {
    const r = computeBorrowingBase(
      {
        arInvoices: [
          inv('c1', 'Acme', 100_000, '2026-07-02'), // current, but tainted below
          inv('c1', 'Acme', 50_000, '2026-03-01'), // >90 days past
        ],
        inventoryValueCents: 0,
        asOf: AS_OF,
      },
      { concentrationCapPct: 0, crossAgeTaint: true },
    );
    expect(r.arPastDueIneligibleCents).toBe(150_000); // whole customer
    expect(r.arCrossAgeIneligibleCents).toBe(100_000); // the extra beyond directly-past-due
    expect(r.eligibleArCents).toBe(0);
    expect(r.availabilityCents).toBe(0);
  });

  it('carves out the concentration excess above the cap', () => {
    const r = computeBorrowingBase(
      {
        arInvoices: [
          inv('a', 'Big Co', 80_000, '2026-07-20'),
          inv('b', 'Small Co', 20_000, '2026-07-20'),
        ],
        inventoryValueCents: 0,
        asOf: AS_OF,
      },
      { concentrationCapPct: 0.2 }, // pool 100000 → cap 20000; Big Co excess = 60000
    );
    expect(r.arConcentrationIneligibleCents).toBe(60_000);
    expect(r.eligibleArCents).toBe(40_000);
    expect(r.arAvailabilityCents).toBe(32_000); // 40000 * 0.80
    expect(r.concentrationFlag).toBe(true);
  });
});

describe('computeBorrowingBase — inventory sublimit', () => {
  it('applies the inventory advance rate then caps at the sublimit', () => {
    const r = computeBorrowingBase(
      { arInvoices: [], inventoryValueCents: 200_000, asOf: AS_OF },
      { inventoryAdvanceRate: 0.5, inventorySublimitCents: 60_000 },
    );
    expect(r.inventoryUncappedAvailabilityCents).toBe(100_000); // 200000 * 0.50
    expect(r.inventoryAvailabilityCents).toBe(60_000); // capped at sublimit
    expect(r.inventorySublimitAppliedCents).toBe(40_000);
    expect(r.borrowingBaseCents).toBe(60_000);
  });
});

describe('computeBorrowingBase — facility limit and availability floor', () => {
  it('takes the min of borrowing base and facility limit', () => {
    const r = computeBorrowingBase(
      { arInvoices: [inv('c1', 'Acme', 100_000, '2026-07-20')], inventoryValueCents: 0, asOf: AS_OF },
      { concentrationCapPct: 0, arAdvanceRate: 0.8, facilityLimitCents: 50_000 },
    );
    expect(r.borrowingBaseCents).toBe(80_000);
    expect(r.cappedBaseCents).toBe(50_000); // min(80000, 50000)
    expect(r.facilityCapAppliedCents).toBe(30_000);
    expect(r.availabilityCents).toBe(50_000);
  });

  it('floors availability at 0 when outstanding exceeds the base', () => {
    const r = computeBorrowingBase(
      { arInvoices: [inv('c1', 'Acme', 100_000, '2026-07-20')], inventoryValueCents: 0, asOf: AS_OF },
      { concentrationCapPct: 0, arAdvanceRate: 0.8, outstandingCents: 120_000 },
    );
    expect(r.cappedBaseCents).toBe(80_000);
    expect(r.availabilityCents).toBe(0); // max(0, 80000 - 120000)
  });
});

describe('computeBorrowingBase — empty inputs', () => {
  it('returns an all-zero certificate for no collateral', () => {
    const r = computeBorrowingBase({ arInvoices: [], inventoryValueCents: 0, asOf: AS_OF });
    expect(r.grossArCents).toBe(0);
    expect(r.eligibleArCents).toBe(0);
    expect(r.borrowingBaseCents).toBe(0);
    expect(r.availabilityCents).toBe(0);
    expect(r.topCustomer).toBeNull();
    expect(r.concentrationFlag).toBe(false);
  });
});
