/**
 * AR ACTIVITY (BALANCE-FORWARD) LEDGER — the "running balance" half of a customer
 * statement (FPB-invoices §7, matrix row B7).
 *
 * An OPEN-ITEM statement lists only what's still owed (built in
 * `lib/invoices/statement.ts`). An ACTIVITY statement is balance-forward: it opens
 * with the balance carried into the window, then walks every charge (invoice) and
 * every payment/credit in date order, showing a running balance after each — the
 * form QBO/Sage print and the one a controller reconciles against.
 *
 * This module is PURE (no I/O) so the arithmetic — opening-balance roll-up, txn
 * ordering, running balance — is unit-testable without a DB. The loader hydrates
 * the inputs from Supabase and calls `buildActivityLedger`.
 *
 * Money is bigint cents throughout (never floats). A charge (invoice) INCREASES
 * the balance; a payment/credit DECREASES it. Same-day ties order charges before
 * payments so an invoice paid the day it's issued reads issue → pay, not the
 * reverse (which would flash a negative balance).
 */

export type LedgerTxnKind = 'invoice' | 'payment' | 'credit';

/** One row of the balance-forward statement, after the running balance is applied. */
export interface StatementTxn {
  /** YYYY-MM-DD */
  date: string;
  kind: LedgerTxnKind;
  /** Invoice number or payment reference (may be empty for on-account payments). */
  ref: string;
  /** Human label, e.g. "Invoice INV-1001" or "Payment received (ACH)". */
  description: string;
  /** Debit that increases what's owed (invoice). 0 for payments. */
  chargeCents: number;
  /** Credit that reduces what's owed (payment/credit). 0 for charges. */
  paymentCents: number;
  /** Running account balance AFTER this transaction. */
  balanceCents: number;
  /** Invoice status when kind === 'invoice' (for a subtle Paid/Overdue tint). */
  status?: string | null;
}

/** A charge (invoice) input, pre-ordering. WRITTEN_OFF / VOIDED must be excluded by the caller. */
export interface LedgerInvoiceInput {
  date: string; // invoice_date
  ref: string; // invoice_number
  amountCents: number; // total_cents (the amount billed)
  status?: string | null;
}

/** A payment/credit input, pre-ordering. */
export interface LedgerPaymentInput {
  date: string; // payment_date
  ref: string; // reference_number (may be '')
  amountCents: number; // amount_cents received (reduces the balance)
  method?: string | null; // CHECK / ACH / WIRE / ...
  /** True for a non-cash credit (credit memo / adjustment) so it labels distinctly. */
  isCredit?: boolean;
}

export interface ActivityLedger {
  openingBalanceCents: number;
  transactions: StatementTxn[];
  closingBalanceCents: number;
  totalChargesCents: number; // charges within the window
  totalPaymentsCents: number; // payments within the window
}

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  CHECK: 'Check',
  ACH: 'ACH',
  WIRE: 'Wire',
  CREDIT_CARD: 'Card',
  CASH: 'Cash',
  OTHER: 'Payment',
};

/** Charges sort before payments on the same date so an invoice never reads "paid before billed". */
const KIND_ORDER: Record<LedgerTxnKind, number> = { invoice: 0, credit: 1, payment: 2 };

interface RawTxn {
  date: string;
  kind: LedgerTxnKind;
  ref: string;
  description: string;
  chargeCents: number;
  paymentCents: number;
  status?: string | null;
}

/**
 * Build a balance-forward ledger.
 *
 * Every charge and payment is walked in date order to accumulate the running
 * balance. Anything dated strictly BEFORE `from` rolls into the opening balance
 * (it isn't shown as a line but its effect carries forward). Anything dated after
 * `to` is ignored — the statement is "as of `to`". With no window, every txn is
 * shown and the opening balance is 0.
 */
export function buildActivityLedger(
  invoices: LedgerInvoiceInput[],
  payments: LedgerPaymentInput[],
  window: { from?: string | null; to?: string | null } = {},
): ActivityLedger {
  const from = window.from ?? null;
  const to = window.to ?? null;

  const raw: RawTxn[] = [];
  for (const inv of invoices) {
    if (!inv.date) continue;
    raw.push({
      date: inv.date,
      kind: 'invoice',
      ref: inv.ref,
      description: inv.ref ? `Invoice ${inv.ref}` : 'Invoice',
      chargeCents: Math.max(0, Math.round(inv.amountCents)),
      paymentCents: 0,
      status: inv.status ?? null,
    });
  }
  for (const p of payments) {
    if (!p.date) continue;
    const amt = Math.max(0, Math.round(p.amountCents));
    const kind: LedgerTxnKind = p.isCredit ? 'credit' : 'payment';
    const method = p.method ? PAYMENT_METHOD_LABEL[p.method] ?? 'Payment' : 'Payment';
    const description = p.isCredit
      ? p.ref
        ? `Credit ${p.ref}`
        : 'Credit / adjustment'
      : `Payment received (${method})${p.ref ? ` · ${p.ref}` : ''}`;
    raw.push({ date: p.date, kind, ref: p.ref, description, chargeCents: 0, paymentCents: amt });
  }

  raw.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  });

  let running = 0;
  let opening = 0;
  let totalCharges = 0;
  let totalPayments = 0;
  const transactions: StatementTxn[] = [];

  for (const t of raw) {
    running += t.chargeCents - t.paymentCents;
    if (from && t.date < from) {
      opening = running; // pre-window: fold into the opening balance, don't display
      continue;
    }
    if (to && t.date > to) continue; // beyond the as-of edge: ignore
    totalCharges += t.chargeCents;
    totalPayments += t.paymentCents;
    transactions.push({
      date: t.date,
      kind: t.kind,
      ref: t.ref,
      description: t.description,
      chargeCents: t.chargeCents,
      paymentCents: t.paymentCents,
      balanceCents: running,
      status: t.status,
    });
  }

  const closing = transactions.length ? transactions[transactions.length - 1].balanceCents : opening;
  return {
    openingBalanceCents: opening,
    transactions,
    closingBalanceCents: closing,
    totalChargesCents: totalCharges,
    totalPaymentsCents: totalPayments,
  };
}
