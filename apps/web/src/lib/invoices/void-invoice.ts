/**
 * Void eligibility for a customer AR invoice (FPB-invoices Wave B, D5 / AC5.4).
 *
 * A book of record NEVER voids a receivable that has taken money. Voiding is only
 * for an invoice that was issued in error and has NOT been paid (in full or in
 * part) and has NOT already been written off. A paid / partially-paid invoice
 * must be corrected with a **credit memo** (or a refund), so the customer's copy
 * and the GL stay in agreement — never voided out from under a payment.
 *
 * This is the PURE guard so the money-sensitive refusal can be asserted in
 * isolation; the route resolves the invoice row and then reverses the issuance
 * journal entry (voidJournalEntry) only when this says `ok`.
 */

export type VoidableInput = {
  status: string;
  /** Any cash/credit already applied to the invoice, bigint cents. */
  amountPaidCents: number;
};

export type VoidableResult =
  | { ok: true }
  /** Already VOIDED — the caller should short-circuit as a no-op success. */
  | { ok: false; idempotent: true; code: 'ALREADY_VOIDED'; message: string; httpStatus: 200 }
  | {
      ok: false;
      idempotent?: false;
      code: 'CANNOT_VOID_PAID' | 'CANNOT_VOID_WRITTEN_OFF' | 'NOTHING_TO_VOID';
      message: string;
      httpStatus: 409;
    };

/**
 * Decide whether an invoice may be voided.
 *
 *   VOIDED                         → idempotent no-op (200)
 *   PAID / PARTIALLY_PAID          → refuse: credit-memo it instead (409)
 *   amountPaid > 0 (any status)    → refuse: money has been applied (409)
 *   WRITTEN_OFF                    → refuse: already off the books (409)
 *   otherwise (DRAFT/SENT/OVERDUE) → allowed
 */
export function assertInvoiceVoidable(inv: VoidableInput): VoidableResult {
  if (inv.status === 'VOIDED') {
    return {
      ok: false,
      idempotent: true,
      code: 'ALREADY_VOIDED',
      message: 'This invoice is already voided.',
      httpStatus: 200,
    };
  }
  if (inv.status === 'WRITTEN_OFF') {
    return {
      ok: false,
      code: 'CANNOT_VOID_WRITTEN_OFF',
      message: 'This invoice was written off. It cannot be voided.',
      httpStatus: 409,
    };
  }
  if (inv.status === 'PAID' || inv.status === 'PARTIALLY_PAID' || inv.amountPaidCents > 0) {
    return {
      ok: false,
      code: 'CANNOT_VOID_PAID',
      message:
        'This invoice has taken payment. Issue a credit memo (or a refund) to reverse it — a paid invoice is never voided.',
      httpStatus: 409,
    };
  }
  return { ok: true };
}
