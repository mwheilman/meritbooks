/**
 * Credit-memo GL posting + application math (FPB-invoices Wave B, D5.1).
 *
 * A customer credit memo is a negative-signed AR document: it reduces what a
 * customer owes. Where an invoice posts **DR AR / CR Revenue**, a credit memo
 * posts the mirror — **DR Revenue (or Deferred Revenue 2410 for a rev-rec-managed
 * job) / CR AR control** — reducing both revenue and the receivable.
 *
 * This module is the PURE core (no I/O) so the balanced-posting shape and the
 * apply-to-invoice arithmetic can be asserted in isolation. The route layer
 * resolves accounts (AR control, per-line rev/deferred, sales-tax) and calls
 * these builders, then hands the lines to `postJournalEntry` (which re-checks
 * debits = credits at the DB trigger — this never posts a guess).
 *
 * Accounting model for APPLY (why apply posts NO new GL):
 *   - Posting the credit memo already credited AR control (DR Rev / CR AR).
 *   - Applying the credit to a specific open invoice is a **sub-ledger
 *     reallocation** — it lowers that invoice's open balance so the AR sub-ledger
 *     total still equals the AR control account. Posting GL again on apply would
 *     double-relieve AR. So apply only advances `amount_paid_cents` (the sole
 *     lever on the generated `balance_cents` column) and never touches the GL.
 */

import type { JournalEntryLineInput } from '@/lib/services/gl-posting';

/** One credit-memo line's debit target (already resolved rev vs deferred). */
export interface CreditMemoDebitLine {
  /** Account to DEBIT — the line's revenue account, or Deferred Revenue when the
   *  linked invoice's job defers recognition (reverses the deferral, not revenue). */
  account_id: string;
  amount_cents: number;
  /** True when routed to Deferred Revenue rather than the line's revenue account. */
  deferred?: boolean;
}

export interface BuildCreditMemoLinesArgs {
  /** Resolved AR control account (role AR_CONTROL). */
  arAccountId: string;
  locationId: string;
  /** Job dimension carried onto every line, when the memo is tied to a job. */
  jobId?: string | null;
  /** Per-line debit targets (revenue / deferred), summing to the subtotal. */
  debitLines: CreditMemoDebitLine[];
  /** Sales tax being reversed, if any (bigint cents). */
  taxCents?: number;
  /** Resolved Sales Tax Payable account (role SALES_TAX_PAYABLE) — required iff taxCents > 0. */
  salesTaxAccountId?: string | null;
}

/**
 * Build the balanced journal lines for POSTING a credit memo.
 *
 *   DR each line's revenue/deferred account   (reduce revenue / clear deferral)
 *   DR Sales Tax Payable (taxCents)           (reverse the tax liability)
 *   CR Accounts Receivable control (total)    (reduce the receivable)
 *
 * total = Σ line amounts + taxCents, so total debits === total credits by
 * construction. Throws if a line/total is non-positive or tax lacks an account.
 */
export function buildCreditMemoJournalLines(args: BuildCreditMemoLinesArgs): JournalEntryLineInput[] {
  const jobDim = args.jobId ?? undefined;
  const taxCents = args.taxCents ?? 0;

  if (args.debitLines.length === 0) throw new Error('Credit memo has no lines');
  for (const l of args.debitLines) {
    if (!Number.isInteger(l.amount_cents) || l.amount_cents <= 0) {
      throw new Error(`Credit memo line amount must be a positive integer cent value (got ${l.amount_cents})`);
    }
  }
  if (taxCents < 0 || !Number.isInteger(taxCents)) throw new Error('Tax must be a non-negative integer cent value');
  if (taxCents > 0 && !args.salesTaxAccountId) throw new Error('Sales tax present but no Sales Tax Payable account resolved');

  const subtotal = args.debitLines.reduce((s, l) => s + l.amount_cents, 0);
  const total = subtotal + taxCents;

  const lines: JournalEntryLineInput[] = args.debitLines.map((l) => ({
    account_id: l.account_id,
    debit_cents: l.amount_cents,
    credit_cents: 0,
    location_id: args.locationId,
    job_id: jobDim,
    memo: l.deferred ? 'Deferred revenue reversal' : 'Revenue reversal',
  }));

  if (taxCents > 0 && args.salesTaxAccountId) {
    lines.push({
      account_id: args.salesTaxAccountId,
      debit_cents: taxCents,
      credit_cents: 0,
      location_id: args.locationId,
      job_id: jobDim,
      memo: 'Sales tax reversal',
    });
  }

  // CR AR control for the full credit total — the receivable reduction.
  lines.push({
    account_id: args.arAccountId,
    debit_cents: 0,
    credit_cents: total,
    location_id: args.locationId,
    job_id: jobDim,
    memo: 'Accounts receivable credit',
  });

  return lines;
}

/**
 * How much of a posted credit memo can be applied to a target invoice right now.
 *
 *   unapplied = creditTotal − creditApplied     (credit still available)
 *   applyCents = min(unapplied, invoiceBalance[, requested])   clamped ≥ 0
 *
 * This is the double-reduce guard: you can never apply more than the credit has
 * left, never more than the invoice still owes, and never a negative amount.
 */
export function computeCreditApplication(args: {
  creditTotalCents: number;
  creditAppliedCents: number;
  invoiceBalanceCents: number;
  requestedCents?: number | null;
}): { applyCents: number } {
  const unapplied = Math.max(0, args.creditTotalCents - args.creditAppliedCents);
  const cap = Math.min(unapplied, Math.max(0, args.invoiceBalanceCents));
  const want = args.requestedCents == null ? cap : Math.min(args.requestedCents, cap);
  return { applyCents: Math.max(0, want) };
}

/** New invoice paid-amount + status after applying `applyCents` of credit. */
export function nextInvoiceStateAfterCredit(args: {
  prevPaidCents: number;
  totalCents: number;
  applyCents: number;
}): { newPaidCents: number; status: 'PAID' | 'PARTIALLY_PAID' } {
  const newPaidCents = args.prevPaidCents + args.applyCents;
  return { newPaidCents, status: newPaidCents >= args.totalCents ? 'PAID' : 'PARTIALLY_PAID' };
}

/** New credit-memo applied-amount + status after applying `applyCents`. */
export function nextCreditMemoStateAfterApply(args: {
  prevAppliedCents: number;
  totalCents: number;
  applyCents: number;
}): { newAppliedCents: number; status: 'APPLIED' | 'POSTED' } {
  const newAppliedCents = args.prevAppliedCents + args.applyCents;
  return { newAppliedCents, status: newAppliedCents >= args.totalCents ? 'APPLIED' : 'POSTED' };
}
