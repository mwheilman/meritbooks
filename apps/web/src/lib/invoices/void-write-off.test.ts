/**
 * Void guard + bad-debt write-off posting (FPB-invoices Wave B, AC5.4 / AC5.5).
 *
 * Money-sensitive facts asserted here:
 *   1. Void is REFUSED for any invoice that has taken payment (must credit-memo),
 *      idempotent when already voided, allowed only for an unpaid invoice.
 *   2. The bad-debt write-off entry BALANCES: DR Bad Debt Expense / CR AR control
 *      for the open balance, and the balance math zeroes the invoice.
 */

import { describe, it, expect } from 'vitest';
import { assertInvoiceVoidable } from './void-invoice';
import { buildWriteOffJournalLines, computeWriteOff } from './write-off-posting';

const BAD_DEBT = 'bad-debt-expense-acct';
const AR = 'ar-control-acct';
const LOC = 'loc-1';

describe('assertInvoiceVoidable — never void money that has been taken', () => {
  it('allows an unpaid SENT invoice', () => {
    expect(assertInvoiceVoidable({ status: 'SENT', amountPaidCents: 0 })).toEqual({ ok: true });
  });

  it('allows an unpaid OVERDUE invoice', () => {
    expect(assertInvoiceVoidable({ status: 'OVERDUE', amountPaidCents: 0 })).toEqual({ ok: true });
  });

  it('refuses a fully PAID invoice with CANNOT_VOID_PAID (409)', () => {
    const r = assertInvoiceVoidable({ status: 'PAID', amountPaidCents: 100_00 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('CANNOT_VOID_PAID');
      expect(r.httpStatus).toBe(409);
    }
  });

  it('refuses a PARTIALLY_PAID invoice', () => {
    const r = assertInvoiceVoidable({ status: 'PARTIALLY_PAID', amountPaidCents: 40_00 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('CANNOT_VOID_PAID');
  });

  it('refuses when money is applied even if status looks open (defensive)', () => {
    const r = assertInvoiceVoidable({ status: 'SENT', amountPaidCents: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('CANNOT_VOID_PAID');
  });

  it('refuses a WRITTEN_OFF invoice', () => {
    const r = assertInvoiceVoidable({ status: 'WRITTEN_OFF', amountPaidCents: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('CANNOT_VOID_WRITTEN_OFF');
  });

  it('is idempotent for an already-VOIDED invoice (200 no-op)', () => {
    const r = assertInvoiceVoidable({ status: 'VOIDED', amountPaidCents: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('ALREADY_VOIDED');
      expect(r.idempotent).toBe(true);
      expect(r.httpStatus).toBe(200);
    }
  });
});

describe('buildWriteOffJournalLines — the entry balances', () => {
  const sumDebits = (l: ReturnType<typeof buildWriteOffJournalLines>) => l.reduce((s, x) => s + x.debit_cents, 0);
  const sumCredits = (l: ReturnType<typeof buildWriteOffJournalLines>) => l.reduce((s, x) => s + x.credit_cents, 0);

  it('DR Bad Debt / CR AR for the open balance, balanced', () => {
    const lines = buildWriteOffJournalLines({
      badDebtAccountId: BAD_DEBT, arAccountId: AR, locationId: LOC, amountCents: 75_000,
    });
    expect(sumDebits(lines)).toBe(75_000);
    expect(sumCredits(lines)).toBe(75_000);
    expect(sumDebits(lines)).toBe(sumCredits(lines));

    const badDebt = lines.find((l) => l.account_id === BAD_DEBT)!;
    const ar = lines.find((l) => l.account_id === AR)!;
    expect(badDebt.debit_cents).toBe(75_000); // expense is DEBITED (loss recognized)
    expect(badDebt.credit_cents).toBe(0);
    expect(ar.credit_cents).toBe(75_000); // AR is CREDITED (receivable relieved)
    expect(ar.debit_cents).toBe(0);
  });

  it('carries the job dimension onto both lines', () => {
    const lines = buildWriteOffJournalLines({
      badDebtAccountId: BAD_DEBT, arAccountId: AR, locationId: LOC, jobId: 'job-9', amountCents: 10_00,
    });
    expect(lines.every((l) => l.job_id === 'job-9')).toBe(true);
  });

  it('rejects a non-positive amount', () => {
    expect(() => buildWriteOffJournalLines({ badDebtAccountId: BAD_DEBT, arAccountId: AR, locationId: LOC, amountCents: 0 })).toThrow();
    expect(() => buildWriteOffJournalLines({ badDebtAccountId: BAD_DEBT, arAccountId: AR, locationId: LOC, amountCents: -5 })).toThrow();
  });

  it('rejects the same account on both sides', () => {
    expect(() => buildWriteOffJournalLines({ badDebtAccountId: AR, arAccountId: AR, locationId: LOC, amountCents: 100 })).toThrow();
  });
});

describe('computeWriteOff — writes off the open balance and zeroes the invoice', () => {
  it('unpaid invoice: writes off the full total', () => {
    expect(computeWriteOff({ totalCents: 100_000, amountPaidCents: 0 })).toEqual({
      writeOffCents: 100_000,
      newPaidCents: 100_000,
    });
  });

  it('partially-paid invoice: writes off only the remaining balance and zeroes it', () => {
    const r = computeWriteOff({ totalCents: 100_000, amountPaidCents: 40_000 });
    expect(r.writeOffCents).toBe(60_000);
    expect(r.newPaidCents).toBe(100_000); // balance_cents = total − paid → 0, drops from aging
  });

  it('nothing to write off when already covered', () => {
    expect(computeWriteOff({ totalCents: 100_000, amountPaidCents: 100_000 }).writeOffCents).toBe(0);
  });
});
