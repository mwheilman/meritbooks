/**
 * In-reconciliation adjusting entries (FPB Bank Reconciliation, Wave B / D6.1).
 *
 * A bank statement almost always carries lines the book doesn't have yet — a
 * monthly service charge, an interest credit, a small error correction. Booking
 * them from inside the reconciliation is what lets the rec tie to $0. This is the
 * PURE, I/O-free core: given the two resolved accounts (the bank's GL cash account
 * and the offset expense/income account), it produces the balanced
 * `JournalEntryLineInput[]` the deterministic engine posts.
 *
 * Correct-by-construction: the offset leg MIRRORS the cash leg's debit/credit, so
 * the entry is balanced whatever the offset account's type. Direction on the cash
 * leg is derived MECHANICALLY from the account type (never hard-coded):
 *
 *   • Bank fee     → cash DECREASES → DR Bank-Fee Expense / CR Cash
 *   • Interest     → cash INCREASES → DR Cash / CR Interest Income
 *   • Other        → caller supplies the offset account + which way cash moves
 *
 * All amounts are bigint cents; the amount is a positive magnitude and the sign
 * is expressed through `cashEffect`. The API route resolves the real accounts
 * (bank_accounts.account_id for cash; the MERCHANT_FEE_EXPENSE role or a chosen
 * account for the offset), posts via `postJournalEntry`, and mirrors the entry as
 * a `bank_transactions` line so it clears in the reconciliation.
 */

import type { JournalEntryLineInput } from '@/lib/services/gl-posting';
import { debitCreditFor, type AccountType, type AccountSubType } from '@/lib/posting/account-direction';

export type AdjustmentType = 'bank_fee' | 'interest' | 'other';
export type CashEffect = 'increase' | 'decrease';

/** The type/sub-type the direction helper needs to place debit vs credit. */
export interface AdjustmentAccountRef {
  id: string;
  account_type: AccountType;
  account_sub_type: AccountSubType;
}

/**
 * The natural cash direction of each adjustment type. A fee takes money OUT of
 * the bank; interest puts money IN. `other` is caller-directed (it can be either
 * a charge or a credit), so it has no default.
 */
export const DEFAULT_CASH_EFFECT: Record<AdjustmentType, CashEffect | null> = {
  bank_fee: 'decrease',
  interest: 'increase',
  other: null,
};

/**
 * Signed statement-line amount for the mirror `bank_transactions` row
 * (negative = money out, positive = money in) — the convention the
 * reconciliation balance math (reconciliation-balance.ts) reads.
 */
export function signedStatementAmountCents(cashEffect: CashEffect, amountCents: number): number {
  const magnitude = Math.abs(Math.trunc(amountCents));
  return cashEffect === 'decrease' ? -magnitude : magnitude;
}

/**
 * Build the two balanced GL lines for an adjusting entry. Throws on a
 * non-positive amount or a self-referential entry — never returns an unbalanced
 * or degenerate pair.
 */
export function buildAdjustmentLines(input: {
  cashAccount: AdjustmentAccountRef;
  offsetAccount: AdjustmentAccountRef;
  amountCents: number;
  cashEffect: CashEffect;
  locationId: string;
  memo: string;
}): JournalEntryLineInput[] {
  const { cashAccount, offsetAccount, amountCents, cashEffect, locationId, memo } = input;

  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error(`Adjustment amount must be a positive integer cents value, got ${amountCents}`);
  }
  if (cashAccount.id === offsetAccount.id) {
    throw new Error('Adjustment cash and offset accounts must differ');
  }

  // Cash-side direction from the account's own normal balance + the intended effect.
  const cash = debitCreditFor(
    cashAccount.account_type,
    cashEffect,
    amountCents,
    cashAccount.account_sub_type,
  );

  // Offset MIRRORS the cash leg → balanced by construction for any offset type.
  return [
    {
      account_id: cashAccount.id,
      debit_cents: cash.debit_cents,
      credit_cents: cash.credit_cents,
      location_id: locationId,
      memo,
    },
    {
      account_id: offsetAccount.id,
      debit_cents: cash.credit_cents,
      credit_cents: cash.debit_cents,
      location_id: locationId,
      memo,
    },
  ];
}
