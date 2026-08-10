import { describe, it, expect } from 'vitest';
import {
  remainingCents,
  statusAfterApply,
  assertCanApply,
  refundableCents,
  buildTakeLines,
  buildApplyLines,
  buildRefundLines,
  computeTieOut,
  type DepositRow,
} from './service';
import type { AccountRef } from '@/lib/posting';

// Synthetic resolved accounts (only the fields debitCreditFor needs).
const cash: AccountRef = { id: 'acct-cash', account_type: 'ASSET', account_sub_type: 'CURRENT_ASSET', account_number: '1000' };
const undeposited: AccountRef = { id: 'acct-uf', account_type: 'ASSET', account_sub_type: 'CURRENT_ASSET', account_number: '1090' };
const deposits: AccountRef = { id: 'acct-2420', account_type: 'LIABILITY', account_sub_type: 'CURRENT_LIABILITY', account_number: '2420' };
const ar: AccountRef = { id: 'acct-1100', account_type: 'ASSET', account_sub_type: 'CURRENT_ASSET', account_number: '1100' };

const LOC = 'loc-1';

function sum(lines: { debit_cents: number; credit_cents: number }[]) {
  return {
    debits: lines.reduce((s, l) => s + l.debit_cents, 0),
    credits: lines.reduce((s, l) => s + l.credit_cents, 0),
  };
}

function depositFixture(over: Partial<DepositRow> = {}): DepositRow {
  return {
    id: 'dep-1', org_id: 'org-1', location_id: LOC, customer_id: 'cust-1', job_id: null,
    deposit_date: '2026-08-01', amount_cents: 100_000, applied_cents: 0, refunded_cents: 0,
    status: 'HELD', currency: 'USD', source_payment_id: null, journal_entry_id: 'je-1',
    memo: null, created_by: null, created_at: '', updated_at: '', ...over,
  };
}

describe('take deposit JE', () => {
  it('DR Cash / CR Customer Deposits(2420), balanced, correct sides', () => {
    const lines = buildTakeLines({ cash, deposits }, 100_000, LOC);
    const { debits, credits } = sum(lines);
    expect(debits).toBe(100_000);
    expect(credits).toBe(100_000); // balanced

    const cashLine = lines.find((l) => l.account_id === 'acct-cash')!;
    const depLine = lines.find((l) => l.account_id === 'acct-2420')!;
    expect(cashLine.debit_cents).toBe(100_000); // asset increase -> debit
    expect(cashLine.credit_cents).toBe(0);
    expect(depLine.credit_cents).toBe(100_000); // liability increase -> credit
    expect(depLine.debit_cents).toBe(0);
  });

  it('undeposited-funds variant still debits the asset side', () => {
    const lines = buildTakeLines({ cash: undeposited, deposits }, 50_000, LOC);
    const ufLine = lines.find((l) => l.account_id === 'acct-uf')!;
    expect(ufLine.debit_cents).toBe(50_000);
    const { debits, credits } = sum(lines);
    expect(debits).toBe(credits);
  });
});

describe('apply reduces remaining and cannot exceed amount', () => {
  it('apply JE is DR 2420 / CR AR and balances', () => {
    const lines = buildApplyLines({ deposits, ar }, 40_000, LOC);
    const depLine = lines.find((l) => l.account_id === 'acct-2420')!;
    const arLine = lines.find((l) => l.account_id === 'acct-1100')!;
    expect(depLine.debit_cents).toBe(40_000); // liability decrease -> debit
    expect(arLine.credit_cents).toBe(40_000); // asset decrease -> credit
    const { debits, credits } = sum(lines);
    expect(debits).toBe(credits);
  });

  it('remainingCents shrinks as applied grows', () => {
    expect(remainingCents(depositFixture())).toBe(100_000);
    expect(remainingCents(depositFixture({ applied_cents: 40_000 }))).toBe(60_000);
    expect(remainingCents(depositFixture({ applied_cents: 100_000 }))).toBe(0);
  });

  it('assertCanApply rejects over-application beyond remaining', () => {
    const d = depositFixture({ applied_cents: 80_000, status: 'PARTIALLY_APPLIED' }); // 20k left
    expect(() => assertCanApply(d, 999_999, 20_001)).toThrow(/remaining/);
    expect(() => assertCanApply(d, 999_999, 20_000)).not.toThrow();
  });

  it('assertCanApply rejects amounts exceeding the invoice balance', () => {
    const d = depositFixture(); // 100k held
    expect(() => assertCanApply(d, 30_000, 30_001)).toThrow(/invoice/);
  });

  it('assertCanApply rejects non-positive amounts and refunded deposits', () => {
    expect(() => assertCanApply(depositFixture(), 100_000, 0)).toThrow(/positive/);
    expect(() => assertCanApply(depositFixture({ status: 'REFUNDED', refunded_cents: 100_000 }), 100_000, 10_000)).toThrow(/refunded/);
  });
});

describe('status transitions', () => {
  it('HELD -> PARTIALLY_APPLIED -> APPLIED', () => {
    expect(statusAfterApply(100_000, 0)).toBe('HELD');
    expect(statusAfterApply(100_000, 40_000)).toBe('PARTIALLY_APPLIED');
    expect(statusAfterApply(100_000, 100_000)).toBe('APPLIED');
  });
});

describe('refund of the unapplied remainder', () => {
  it('refundableCents equals amount minus applied minus refunded', () => {
    expect(refundableCents(depositFixture({ applied_cents: 30_000 }))).toBe(70_000);
    expect(refundableCents(depositFixture({ applied_cents: 30_000, refunded_cents: 70_000 }))).toBe(0);
  });

  it('refund JE is DR 2420 / CR Cash for the remainder and balances', () => {
    const remainder = refundableCents(depositFixture({ applied_cents: 30_000 })); // 70k
    const lines = buildRefundLines({ deposits, cash }, remainder, LOC);
    const depLine = lines.find((l) => l.account_id === 'acct-2420')!;
    const cashLine = lines.find((l) => l.account_id === 'acct-cash')!;
    expect(depLine.debit_cents).toBe(70_000); // liability decrease -> debit
    expect(cashLine.credit_cents).toBe(70_000); // asset decrease -> credit
    const { debits, credits } = sum(lines);
    expect(debits).toBe(credits);
  });
});

describe('subledger-to-GL tie-out', () => {
  it('ties when the open remainders equal the 2420 credit balance', () => {
    const rows = [
      depositFixture({ amount_cents: 100_000, applied_cents: 40_000, status: 'PARTIALLY_APPLIED' }), // 60k
      depositFixture({ amount_cents: 25_000, status: 'HELD' }), // 25k
      depositFixture({ amount_cents: 10_000, applied_cents: 10_000, status: 'APPLIED' }), // 0
    ];
    const tie = computeTieOut(rows, 85_000);
    expect(tie.subledgerCents).toBe(85_000);
    expect(tie.differenceCents).toBe(0);
    expect(tie.inBalance).toBe(true);
  });

  it('flags an out-of-balance difference', () => {
    const rows = [depositFixture({ amount_cents: 50_000 })]; // 50k open
    const tie = computeTieOut(rows, 48_000);
    expect(tie.differenceCents).toBe(2_000);
    expect(tie.inBalance).toBe(false);
  });
});
