/**
 * In-reconciliation adjusting-entry guardrail (FPB Bank Reconciliation, Wave B).
 *
 * Proves the two money-sensitive invariants for a fee/interest adjustment booked
 * from a reconciliation:
 *   1. The entry is BALANCED (debits === credits) — the DB trigger would reject
 *      it otherwise, but we fail fast here.
 *   2. The debit/credit DIRECTION is right for each named case, derived from
 *      account type, never hard-coded:
 *        • Bank fee → DR Bank-Fee Expense / CR Cash   (cash decreases)
 *        • Interest → DR Cash / CR Interest Income     (cash increases)
 */

import { describe, it, expect } from 'vitest';
import {
  buildAdjustmentLines,
  signedStatementAmountCents,
  DEFAULT_CASH_EFFECT,
  type AdjustmentAccountRef,
} from './reconciliation-adjustment';

const cash: AdjustmentAccountRef = {
  id: 'acct-cash',
  account_type: 'ASSET',
  account_sub_type: 'CURRENT_ASSET',
};
const bankFeeExpense: AdjustmentAccountRef = {
  id: 'acct-bank-fee',
  account_type: 'OPEX',
  account_sub_type: 'OPERATING_EXPENSE',
};
const interestIncome: AdjustmentAccountRef = {
  id: 'acct-interest',
  account_type: 'REVENUE',
  account_sub_type: 'REVENUE',
};

const balanced = (lines: { debit_cents: number; credit_cents: number }[]) => {
  const d = lines.reduce((s, l) => s + l.debit_cents, 0);
  const c = lines.reduce((s, l) => s + l.credit_cents, 0);
  return d === c && d > 0;
};

describe('buildAdjustmentLines — bank fee', () => {
  const lines = buildAdjustmentLines({
    cashAccount: cash,
    offsetAccount: bankFeeExpense,
    amountCents: 2500,
    cashEffect: 'decrease',
    locationId: 'loc-1',
    memo: 'Monthly service charge',
  });

  it('is balanced', () => {
    expect(balanced(lines)).toBe(true);
  });

  it('debits the expense and credits cash (DR Bank Fees / CR Cash)', () => {
    const cashLine = lines.find((l) => l.account_id === 'acct-cash')!;
    const feeLine = lines.find((l) => l.account_id === 'acct-bank-fee')!;
    expect(cashLine).toMatchObject({ debit_cents: 0, credit_cents: 2500 });
    expect(feeLine).toMatchObject({ debit_cents: 2500, credit_cents: 0 });
  });
});

describe('buildAdjustmentLines — interest income', () => {
  const lines = buildAdjustmentLines({
    cashAccount: cash,
    offsetAccount: interestIncome,
    amountCents: 1075,
    cashEffect: 'increase',
    locationId: 'loc-1',
    memo: 'Interest earned',
  });

  it('is balanced', () => {
    expect(balanced(lines)).toBe(true);
  });

  it('debits cash and credits income (DR Cash / CR Interest Income)', () => {
    const cashLine = lines.find((l) => l.account_id === 'acct-cash')!;
    const incomeLine = lines.find((l) => l.account_id === 'acct-interest')!;
    expect(cashLine).toMatchObject({ debit_cents: 1075, credit_cents: 0 });
    expect(incomeLine).toMatchObject({ debit_cents: 0, credit_cents: 1075 });
  });
});

describe('buildAdjustmentLines — guards', () => {
  it('rejects a non-positive amount', () => {
    expect(() =>
      buildAdjustmentLines({
        cashAccount: cash,
        offsetAccount: bankFeeExpense,
        amountCents: 0,
        cashEffect: 'decrease',
        locationId: 'loc-1',
        memo: 'x',
      }),
    ).toThrow();
  });

  it('rejects a self-referential entry', () => {
    expect(() =>
      buildAdjustmentLines({
        cashAccount: cash,
        offsetAccount: cash,
        amountCents: 100,
        cashEffect: 'decrease',
        locationId: 'loc-1',
        memo: 'x',
      }),
    ).toThrow();
  });
});

describe('signedStatementAmountCents', () => {
  it('makes a fee an outflow and interest an inflow', () => {
    expect(signedStatementAmountCents('decrease', 2500)).toBe(-2500);
    expect(signedStatementAmountCents('increase', 1075)).toBe(1075);
  });

  it('has the expected default cash direction per type', () => {
    expect(DEFAULT_CASH_EFFECT.bank_fee).toBe('decrease');
    expect(DEFAULT_CASH_EFFECT.interest).toBe('increase');
    expect(DEFAULT_CASH_EFFECT.other).toBeNull();
  });
});
