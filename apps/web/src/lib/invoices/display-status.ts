/**
 * THE invoice status a person sees — one derivation for every invoice surface (list row,
 * list tabs, detail drawer, hover peek). PURE — safe in client and server code.
 *
 * Why: the list derived OVERDUE from the due date (lib/ar/overdue) while the drawer only
 * asked "was it ever emailed?" (lib/invoices/delivery-state), so INV-NWC-202606-0001 read
 * "Overdue · 103d late" in the list and "Issued" in its drawer. Both now call
 * `deriveInvoiceStatus` with the same facts.
 *
 * Precedence (first match wins):
 *   1. OVERDUE  — open status ∧ balance > 0 ∧ past due (lib/ar/overdue `isInvoiceOverdue`).
 *                 Overdue is what matters for collection, whether or not it was ever emailed;
 *                 the "never sent" fact rides along in `hint` / `sentToCustomer`.
 *   2. ISSUED   — stored SENT (posted, collectible) but nothing ever reached the customer.
 *   3. the effective stored status (stale OVERDUE reverts to SENT / PARTIALLY_PAID).
 *
 * "Reached the customer" = invoices.sent_at, or any delivery evidence in invoice_events:
 * an email send, a reminder email, a delivery receipt, or the customer opening / paying
 * through the hosted link (they cannot open a link they never received).
 */

import { daysPastDue, effectiveInvoiceStatus, isInvoiceOverdue } from '@/lib/ar/overdue';

export type InvoiceDisplayKey =
  | 'DRAFT'
  | 'ISSUED'
  | 'SENT'
  | 'PARTIALLY_PAID'
  | 'OVERDUE'
  | 'PAID'
  | 'VOIDED'
  | 'WRITTEN_OFF';

/** Plain-English word per display key (the one label map every surface uses). */
export const INVOICE_STATUS_LABELS: Record<InvoiceDisplayKey, string> = {
  DRAFT: 'Draft',
  ISSUED: 'Issued',
  SENT: 'Sent',
  PARTIALLY_PAID: 'Partly paid',
  OVERDUE: 'Overdue',
  PAID: 'Paid',
  VOIDED: 'Voided',
  WRITTEN_OFF: 'Written off',
};

/** invoice_events types that prove the invoice reached the customer. */
export const DELIVERY_EVIDENCE_EVENTS: readonly string[] = [
  'SENT',
  'REMINDER_SENT',
  'DELIVERED',
  'VIEWED',
  'PAY_INITIATED',
  'PAY_PROCESSING',
  'PAY_SUCCEEDED',
  'PAY_FAILED',
];
const EVIDENCE = new Set(DELIVERY_EVIDENCE_EVENTS);

export function hasReachedCustomer(
  events: ReadonlyArray<{ event_type: string }>,
  sentAtColumn: string | null | undefined,
): boolean {
  if (sentAtColumn) return true;
  return events.some((e) => EVIDENCE.has(e.event_type));
}

export interface InvoiceStatusFacts {
  status: string | null | undefined;
  dueDate: string | null | undefined;
  balanceCents: number | string | null | undefined;
  amountPaidCents?: number | string | null;
  /** `hasReachedCustomer(...)` — omit when unknown (treated as sent: no "Issued" downgrade). */
  sentToCustomer?: boolean;
}

export interface InvoiceDisplayStatus {
  key: InvoiceDisplayKey;
  label: string;
  /** Calendar days past due (0 unless OVERDUE). */
  daysOverdue: number;
  /** "Overdue · 103d late" — the compact word the list and drawer both print. */
  detail: string;
  /** Plain words for a tooltip / screen reader; null when the label says it all. */
  hint: string | null;
  sentToCustomer: boolean;
  storedStatus: string;
}

function asKey(s: string): InvoiceDisplayKey {
  return (Object.prototype.hasOwnProperty.call(INVOICE_STATUS_LABELS, s) ? s : 'DRAFT') as InvoiceDisplayKey;
}

export function deriveInvoiceStatus(f: InvoiceStatusFacts, today: string): InvoiceDisplayStatus {
  const stored = f.status ?? '';
  const sent = f.sentToCustomer ?? true;
  const ov = { status: stored, dueDate: f.dueDate, balanceCents: f.balanceCents, amountPaidCents: f.amountPaidCents };
  if (isInvoiceOverdue(ov, today)) {
    const days = daysPastDue(f.dueDate, today);
    return {
      key: 'OVERDUE',
      label: INVOICE_STATUS_LABELS.OVERDUE,
      daysOverdue: days,
      detail: `Overdue · ${days}d late`,
      hint: `${days} day${days === 1 ? '' : 's'} past due${sent ? '' : ' — and never emailed to the customer'}.`,
      sentToCustomer: sent,
      storedStatus: stored,
    };
  }
  const eff = effectiveInvoiceStatus(ov, today);
  if (eff === 'SENT' && !sent) {
    return {
      key: 'ISSUED',
      label: INVOICE_STATUS_LABELS.ISSUED,
      daysOverdue: 0,
      detail: INVOICE_STATUS_LABELS.ISSUED,
      hint: 'Issued and on the books, but not sent to the customer yet.',
      sentToCustomer: false,
      storedStatus: stored,
    };
  }
  const key = asKey(eff);
  return { key, label: INVOICE_STATUS_LABELS[key], daysOverdue: 0, detail: INVOICE_STATUS_LABELS[key], hint: null, sentToCustomer: sent, storedStatus: stored };
}
