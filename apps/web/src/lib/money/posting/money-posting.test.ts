/**
 * GL balance + fee-arithmetic assertions for money-movement posting.
 *
 * These are the guardrail behind auto-merge: an agent may only merge when these
 * pass. They assert EXACT CENTS against the locked fee rules (handoff §3), not
 * "an entry was created". Every scenario also re-derives debits == credits, so a
 * refactor that silently unbalances an entry fails here rather than in the books.
 *
 * Pure functions only — no DB, no network. Integration tests that hit a Supabase
 * branch live separately.
 */

import { describe, it, expect } from 'vitest';
import { buildArCollectionEntry, buildArPayoutEntry } from './ar-posting';
import { buildPlatformFeeEntry } from './platform-fee';
import { deriveTenantFeeCents } from '../apply-invoice-payment';
import { assertBalanced, line, type MoneyMovementEntry } from './types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LOC = 'loc-test-0001';

const AR_ACC = {
  settlementClearingId: 'acct-1095-settlement-clearing',
  merchantFeeExpenseId: 'acct-6xxx-merchant-fee',
  arControlId: 'acct-1100-ar-control',
};

const PF_ACC = {
  inTransitId: 'acct-1096-payments-in-transit',
  processingCostId: 'acct-6xxx-processing-cost',
  feeIncomeId: 'acct-4910-payment-processing-income',
};

/** The canonical scenario invoice: $150,000.00 */
const BASE = 15_000_000;

const debits = (e: MoneyMovementEntry) => e.lines.reduce((s, l) => s + l.debit_cents, 0);
const credits = (e: MoneyMovementEntry) => e.lines.reduce((s, l) => s + l.credit_cents, 0);
const amountOn = (e: MoneyMovementEntry, accountId: string, side: 'debit' | 'credit') =>
  e.lines
    .filter((l) => l.account_id === accountId)
    .reduce((s, l) => s + (side === 'debit' ? l.debit_cents : l.credit_cents), 0);

/**
 * Tenant-borne fee per the locked rule:
 *   GL fee on tenant's books = base - (amount_charged - application_fee)
 */
const tenantFeeCents = (base: number, charged: number, appFee: number) => base - (charged - appFee);

// ---------------------------------------------------------------------------
// The production fee derivation (the function the webhook actually calls)
// ---------------------------------------------------------------------------

describe('deriveTenantFeeCents — the shipped derivation, not a re-implementation', () => {
  it('ACH 1%: tenant bears the full application fee', () => {
    expect(deriveTenantFeeCents(BASE, BASE, 150_000)).toBe(150_000);
  });

  it('card pass-through 3%: surcharge covers it, tenant bears nothing', () => {
    expect(deriveTenantFeeCents(BASE, BASE + 450_000, 450_000)).toBe(0);
  });

  it('card absorbed 3%: tenant bears the full 3%', () => {
    expect(deriveTenantFeeCents(BASE, BASE, 450_000)).toBe(450_000);
  });

  it('never returns a negative fee, even if the customer overpays', () => {
    expect(deriveTenantFeeCents(BASE, BASE + 1_000_000, 0)).toBe(0);
  });

  it('agrees with the local formula across the scenario matrix', () => {
    const cases: Array<[number, number, number]> = [
      [BASE, BASE, 150_000],
      [BASE, BASE + 450_000, 450_000],
      [BASE, BASE, 450_000],
      [1, 1, 0],
      [100_000, 100_000, 1_000],
    ];
    for (const [base, charged, af] of cases) {
      expect(deriveTenantFeeCents(base, charged, af)).toBe(tenantFeeCents(base, charged, af));
    }
  });

  it('produces a fee that never exceeds the gross (would throw in the builder)', () => {
    for (const [base, charged, af] of [
      [BASE, BASE, 150_000],
      [BASE, BASE, 450_000],
      [100_000, 100_000, 1_000],
    ] as Array<[number, number, number]>) {
      const fee = deriveTenantFeeCents(base, charged, af);
      expect(fee).toBeLessThanOrEqual(base);
      expect(() => buildArCollectionEntry(AR_ACC, base, fee, LOC)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Universal invariant — nothing may post unbalanced
// ---------------------------------------------------------------------------

describe('double-entry invariant', () => {
  it('rejects an unbalanced entry outright', () => {
    expect(() =>
      assertBalanced({
        entryType: 'BROKEN',
        memo: 'debits != credits',
        lines: [line('a', 'debit', 100, LOC), line('b', 'credit', 99, LOC)],
      }),
    ).toThrow(/Unbalanced/);
  });

  it('rejects a single-sided entry', () => {
    expect(() =>
      assertBalanced({
        entryType: 'BROKEN',
        memo: 'one line',
        lines: [line('a', 'debit', 100, LOC)],
      }),
    ).toThrow();
  });

  it('rejects a zero-amount entry', () => {
    expect(() =>
      assertBalanced({
        entryType: 'BROKEN',
        memo: 'no amounts',
        lines: [line('a', 'debit', 0, LOC), line('b', 'credit', 0, LOC)],
      }),
    ).toThrow(/no amounts/);
  });

  it('never emits a negative line amount', () => {
    expect(() => line('a', 'debit', -1, LOC)).toThrow(/non-negative/);
  });
});

// ---------------------------------------------------------------------------
// Fee scenarios — exact cents, per the locked rules
// ---------------------------------------------------------------------------

describe('AR collection — ACH at 1% uncapped', () => {
  // Customer pays base. App fee = 1% of base. Tenant nets base - 1%.
  const appFee = BASE * 0.01; // 150_000 cents = $1,500.00
  const charged = BASE;
  const fee = tenantFeeCents(BASE, charged, appFee);
  const entry = buildArCollectionEntry(AR_ACC, BASE, fee, LOC);

  it('charges the customer the invoice total, unchanged', () => {
    expect(charged).toBe(15_000_000);
  });

  it('computes a $1,500.00 application fee', () => {
    expect(appFee).toBe(150_000);
  });

  it('books the tenant-borne fee as the full 1%', () => {
    expect(fee).toBe(150_000);
  });

  it('relieves A/R for the gross $150,000.00', () => {
    expect(amountOn(entry, AR_ACC.arControlId, 'credit')).toBe(15_000_000);
  });

  it('debits merchant fee expense $1,500.00', () => {
    expect(amountOn(entry, AR_ACC.merchantFeeExpenseId, 'debit')).toBe(150_000);
  });

  it('nets $148,500.00 into settlement clearing', () => {
    expect(amountOn(entry, AR_ACC.settlementClearingId, 'debit')).toBe(14_850_000);
  });

  it('balances', () => {
    expect(debits(entry)).toBe(credits(entry));
    expect(debits(entry)).toBe(15_000_000);
  });
});

describe('AR collection — card pass-through at 3%', () => {
  // Customer pays base + 3%. App fee = the surcharge. Tenant nets the FULL base.
  const surcharge = BASE * 0.03; // 450_000 cents = $4,500.00
  const charged = BASE + surcharge;
  const appFee = surcharge;
  const fee = tenantFeeCents(BASE, charged, appFee);

  it('charges the customer base plus the 3% surcharge', () => {
    expect(charged).toBe(15_450_000);
  });

  it('leaves the tenant bearing zero fee', () => {
    expect(fee).toBe(0);
  });

  it('nets the tenant the full invoice total', () => {
    const entry = buildArCollectionEntry(AR_ACC, BASE, fee, LOC);
    expect(amountOn(entry, AR_ACC.settlementClearingId, 'debit')).toBe(15_000_000);
    expect(amountOn(entry, AR_ACC.arControlId, 'credit')).toBe(15_000_000);
  });

  it('omits the fee line entirely when the fee is zero', () => {
    const entry = buildArCollectionEntry(AR_ACC, BASE, fee, LOC);
    expect(entry.lines.some((l) => l.account_id === AR_ACC.merchantFeeExpenseId)).toBe(false);
    expect(entry.lines).toHaveLength(2);
  });

  it('balances', () => {
    const entry = buildArCollectionEntry(AR_ACC, BASE, fee, LOC);
    expect(debits(entry)).toBe(credits(entry));
  });
});

describe('AR collection — card absorbed at 3%', () => {
  // Customer pays base. App fee = 3% of base. Tenant nets base - 3%.
  const appFee = BASE * 0.03;
  const charged = BASE;
  const fee = tenantFeeCents(BASE, charged, appFee);
  const entry = buildArCollectionEntry(AR_ACC, BASE, fee, LOC);

  it('books the tenant-borne fee as the full 3%', () => {
    expect(fee).toBe(450_000);
  });

  it('nets $145,500.00 into settlement clearing', () => {
    expect(amountOn(entry, AR_ACC.settlementClearingId, 'debit')).toBe(14_550_000);
  });

  it('still relieves A/R for the gross', () => {
    expect(amountOn(entry, AR_ACC.arControlId, 'credit')).toBe(15_000_000);
  });

  it('balances', () => {
    expect(debits(entry)).toBe(credits(entry));
  });
});

// ---------------------------------------------------------------------------
// Guards — the arithmetic that must never be allowed through
// ---------------------------------------------------------------------------

describe('AR collection guards', () => {
  it('rejects a fee larger than the gross', () => {
    expect(() => buildArCollectionEntry(AR_ACC, 100_000, 100_001, LOC)).toThrow(/out of range/);
  });

  it('rejects a negative fee', () => {
    expect(() => buildArCollectionEntry(AR_ACC, 100_000, -1, LOC)).toThrow(/out of range/);
  });

  it('rejects a zero or negative gross', () => {
    expect(() => buildArCollectionEntry(AR_ACC, 0, 0, LOC)).toThrow(/must be > 0/);
    expect(() => buildArCollectionEntry(AR_ACC, -5, 0, LOC)).toThrow(/must be > 0/);
  });

  it('permits a fee exactly equal to the gross (degenerate but balanced)', () => {
    const entry = buildArCollectionEntry(AR_ACC, 100_000, 100_000, LOC);
    expect(debits(entry)).toBe(credits(entry));
    expect(amountOn(entry, AR_ACC.settlementClearingId, 'debit')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Platform fee income — Merit's own books
// ---------------------------------------------------------------------------

describe('platform fee income on a $150,000 ACH payment', () => {
  const grossFee = 150_000; // $1,500.00 application fee
  const stripeCost = 500; //     $5.00 Stripe processing cost
  const entry = buildPlatformFeeEntry(PF_ACC, grossFee, stripeCost, LOC);

  it('credits Payment Processing Income 4910 the GROSS fee', () => {
    expect(amountOn(entry, PF_ACC.feeIncomeId, 'credit')).toBe(150_000);
  });

  it("debits Stripe's cost as processing expense", () => {
    expect(amountOn(entry, PF_ACC.processingCostId, 'debit')).toBe(500);
  });

  it('debits Payments in Transit the net $1,495.00', () => {
    expect(amountOn(entry, PF_ACC.inTransitId, 'debit')).toBe(149_500);
  });

  it('balances', () => {
    expect(debits(entry)).toBe(credits(entry));
    expect(debits(entry)).toBe(150_000);
  });

  it('omits the cost line when Stripe cost is unavailable (fallback to gross-only)', () => {
    const e = buildPlatformFeeEntry(PF_ACC, grossFee, 0, LOC);
    expect(e.lines.some((l) => l.account_id === PF_ACC.processingCostId)).toBe(false);
    expect(debits(e)).toBe(credits(e));
  });
});

describe('platform fee guards', () => {
  it('rejects a Stripe cost exceeding the gross fee', () => {
    expect(() => buildPlatformFeeEntry(PF_ACC, 1_000, 1_001, LOC)).toThrow(/out of range/);
  });

  it('rejects a non-positive gross fee', () => {
    expect(() => buildPlatformFeeEntry(PF_ACC, 0, 0, LOC)).toThrow(/must be > 0/);
  });
});

// ---------------------------------------------------------------------------
// Payout leg
// ---------------------------------------------------------------------------

describe('AR payout to operating bank', () => {
  it('moves the payout from clearing to bank and balances', () => {
    const entry = buildArPayoutEntry('acct-1000-operating-bank', AR_ACC.settlementClearingId, 14_850_000, LOC);
    expect(amountOn(entry, 'acct-1000-operating-bank', 'debit')).toBe(14_850_000);
    expect(amountOn(entry, AR_ACC.settlementClearingId, 'credit')).toBe(14_850_000);
    expect(debits(entry)).toBe(credits(entry));
  });
});

// ---------------------------------------------------------------------------
// Sweep — balance must hold across the whole plausible amount range
// ---------------------------------------------------------------------------

describe('balance holds across the amount range', () => {
  const amounts = [1, 99, 100, 4_999, 100_000, 15_000_000, 999_999_999];
  const rates = [0, 0.01, 0.03];

  for (const base of amounts) {
    for (const rate of rates) {
      it(`base=${base} rate=${rate} balances with integer cents`, () => {
        const fee = Math.round(base * rate);
        const entry = buildArCollectionEntry(AR_ACC, base, Math.min(fee, base), LOC);
        expect(debits(entry)).toBe(credits(entry));
        expect(entry.lines.every((l) => Number.isInteger(l.debit_cents) && Number.isInteger(l.credit_cents))).toBe(true);
      });
    }
  }
});
