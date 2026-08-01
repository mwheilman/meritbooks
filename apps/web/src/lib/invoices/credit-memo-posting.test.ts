/**
 * Credit-memo posting + apply arithmetic (FPB-invoices Wave B).
 *
 * These assert the two money-sensitive facts a credit memo must never get wrong:
 *   1. The journal entry BALANCES (Σ debits === Σ credits) — DR revenue/deferred
 *      + sales-tax reversal, CR AR control for the full total.
 *   2. Applying a credit to an invoice never over-reduces either side.
 */

import { describe, it, expect } from 'vitest';
import {
  buildCreditMemoJournalLines,
  computeCreditApplication,
  nextInvoiceStateAfterCredit,
  nextCreditMemoStateAfterApply,
} from './credit-memo-posting';

const AR = 'ar-control-acct';
const REV = 'revenue-acct';
const REV2 = 'revenue-acct-2';
const DEFERRED = 'deferred-rev-2410';
const TAX = 'sales-tax-payable';
const LOC = 'loc-1';

const sumDebits = (lines: ReturnType<typeof buildCreditMemoJournalLines>) =>
  lines.reduce((s, l) => s + l.debit_cents, 0);
const sumCredits = (lines: ReturnType<typeof buildCreditMemoJournalLines>) =>
  lines.reduce((s, l) => s + l.credit_cents, 0);

describe('buildCreditMemoJournalLines — the entry balances', () => {
  it('single line: DR Revenue / CR AR, balanced', () => {
    const lines = buildCreditMemoJournalLines({
      arAccountId: AR, locationId: LOC,
      debitLines: [{ account_id: REV, amount_cents: 50_000 }],
    });
    expect(sumDebits(lines)).toBe(50_000);
    expect(sumCredits(lines)).toBe(50_000);
    expect(sumDebits(lines)).toBe(sumCredits(lines));

    const rev = lines.find((l) => l.account_id === REV)!;
    const ar = lines.find((l) => l.account_id === AR)!;
    expect(rev.debit_cents).toBe(50_000); // revenue is DEBITED (reversed)
    expect(rev.credit_cents).toBe(0);
    expect(ar.credit_cents).toBe(50_000); // AR is CREDITED (reduced)
    expect(ar.debit_cents).toBe(0);
  });

  it('multi-line + sales tax: AR credit = Σ lines + tax, balanced', () => {
    const lines = buildCreditMemoJournalLines({
      arAccountId: AR, locationId: LOC,
      debitLines: [
        { account_id: REV, amount_cents: 30_000 },
        { account_id: REV2, amount_cents: 20_000 },
      ],
      taxCents: 4_000,
      salesTaxAccountId: TAX,
    });
    expect(sumDebits(lines)).toBe(54_000);
    expect(sumCredits(lines)).toBe(54_000);

    const ar = lines.find((l) => l.account_id === AR)!;
    expect(ar.credit_cents).toBe(54_000); // full total incl. tax
    const tax = lines.find((l) => l.account_id === TAX)!;
    expect(tax.debit_cents).toBe(4_000); // tax liability reversed (debited)
  });

  it('deferred line carries the deferral memo and still balances', () => {
    const lines = buildCreditMemoJournalLines({
      arAccountId: AR, locationId: LOC, jobId: 'job-1',
      debitLines: [{ account_id: DEFERRED, amount_cents: 100_000, deferred: true }],
    });
    expect(sumDebits(lines)).toBe(sumCredits(lines));
    const d = lines.find((l) => l.account_id === DEFERRED)!;
    expect(d.debit_cents).toBe(100_000);
    expect(d.memo).toMatch(/deferred/i);
    // Job dimension carried onto every line.
    expect(lines.every((l) => l.job_id === 'job-1')).toBe(true);
  });

  it('rejects non-positive line amounts and tax without an account', () => {
    expect(() =>
      buildCreditMemoJournalLines({ arAccountId: AR, locationId: LOC, debitLines: [{ account_id: REV, amount_cents: 0 }] }),
    ).toThrow();
    expect(() =>
      buildCreditMemoJournalLines({ arAccountId: AR, locationId: LOC, debitLines: [{ account_id: REV, amount_cents: -5 }] }),
    ).toThrow();
    expect(() =>
      buildCreditMemoJournalLines({ arAccountId: AR, locationId: LOC, debitLines: [{ account_id: REV, amount_cents: 100 }], taxCents: 10 }),
    ).toThrow(/sales tax/i);
  });
});

describe('computeCreditApplication — the double-reduce guard', () => {
  it('applies the lesser of unapplied credit and invoice balance', () => {
    // $500 credit, fully unapplied, invoice owes $300 → apply $300.
    expect(
      computeCreditApplication({ creditTotalCents: 50_000, creditAppliedCents: 0, invoiceBalanceCents: 30_000 }).applyCents,
    ).toBe(30_000);
    // $300 credit, invoice owes $500 → apply $300 (all of the credit).
    expect(
      computeCreditApplication({ creditTotalCents: 30_000, creditAppliedCents: 0, invoiceBalanceCents: 50_000 }).applyCents,
    ).toBe(30_000);
  });

  it('never applies more than the credit has left', () => {
    // $500 credit already $400 applied → only $100 left, invoice owes $999.
    expect(
      computeCreditApplication({ creditTotalCents: 50_000, creditAppliedCents: 40_000, invoiceBalanceCents: 99_900 }).applyCents,
    ).toBe(10_000);
  });

  it('honors an explicit requested amount, still clamped', () => {
    expect(
      computeCreditApplication({ creditTotalCents: 50_000, creditAppliedCents: 0, invoiceBalanceCents: 30_000, requestedCents: 10_000 }).applyCents,
    ).toBe(10_000);
    // request exceeds the cap → clamped to cap.
    expect(
      computeCreditApplication({ creditTotalCents: 50_000, creditAppliedCents: 0, invoiceBalanceCents: 30_000, requestedCents: 99_999 }).applyCents,
    ).toBe(30_000);
  });

  it('a fully-applied credit or a zero-balance invoice applies nothing', () => {
    expect(
      computeCreditApplication({ creditTotalCents: 50_000, creditAppliedCents: 50_000, invoiceBalanceCents: 30_000 }).applyCents,
    ).toBe(0);
    expect(
      computeCreditApplication({ creditTotalCents: 50_000, creditAppliedCents: 0, invoiceBalanceCents: 0 }).applyCents,
    ).toBe(0);
  });
});

describe('resulting states after apply', () => {
  it('invoice flips to PAID only when fully covered', () => {
    expect(nextInvoiceStateAfterCredit({ prevPaidCents: 0, totalCents: 30_000, applyCents: 30_000 })).toEqual({
      newPaidCents: 30_000, status: 'PAID',
    });
    expect(nextInvoiceStateAfterCredit({ prevPaidCents: 0, totalCents: 50_000, applyCents: 30_000 })).toEqual({
      newPaidCents: 30_000, status: 'PARTIALLY_PAID',
    });
  });

  it('credit memo flips to APPLIED only when fully consumed', () => {
    expect(nextCreditMemoStateAfterApply({ prevAppliedCents: 0, totalCents: 30_000, applyCents: 30_000 })).toEqual({
      newAppliedCents: 30_000, status: 'APPLIED',
    });
    expect(nextCreditMemoStateAfterApply({ prevAppliedCents: 10_000, totalCents: 30_000, applyCents: 10_000 })).toEqual({
      newAppliedCents: 20_000, status: 'POSTED',
    });
  });
});
