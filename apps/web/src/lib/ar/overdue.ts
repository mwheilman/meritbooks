/**
 * Invoice overdue — ONE derivation for every AR surface (audit L4).
 *
 * "Overdue" is DERIVED, never trusted from the stored status: nothing flips
 * `invoices.status` from SENT to OVERDUE on the due date, so an invoice 97 days
 * past due still read "Sent" on Invoices (Overdue $0) while Collections — which
 * derives from the due date — put it in 90+. Every surface (invoice list status
 * chip + tab counts, AR KPIs, collections, aging) now uses these helpers:
 *
 *   overdue  ⇔  status is OPEN  ∧  open balance > 0  ∧  due_date < today
 *
 * where OPEN = not DRAFT / PAID / VOIDED / WRITTEN_OFF and `today` is the ORG's
 * calendar date (lib/dates — never the UTC date). Due today is NOT overdue.
 * PURE — safe in client and server code.
 */

import { daysBetweenIso } from '@/lib/dates/org-date';

/** Stored statuses that are never collectible (mirrors v_ar_aging's exclusion). */
export const CLOSED_INVOICE_STATUSES = ['DRAFT', 'PAID', 'VOIDED', 'WRITTEN_OFF'] as const;
const CLOSED = new Set<string>(CLOSED_INVOICE_STATUSES);

export type AgingBucket = 'CURRENT' | '1-30' | '31-60' | '61-90' | '90+';
export const AGING_BUCKETS: readonly AgingBucket[] = ['CURRENT', '1-30', '31-60', '61-90', '90+'];

export interface OverdueInput {
  status: string | null | undefined;
  dueDate: string | null | undefined;
  balanceCents: number | string | null | undefined;
  amountPaidCents?: number | string | null;
}

const n = (v: number | string | null | undefined): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

/** Is the stored status an open (collectible) one? */
export function isOpenInvoiceStatus(status: string | null | undefined): boolean {
  return !!status && !CLOSED.has(status);
}

/** Calendar days past due as of `today` (0 when not yet due / no due date). */
export function daysPastDue(dueDate: string | null | undefined, today: string): number {
  if (!dueDate) return 0;
  return Math.max(0, daysBetweenIso(today, dueDate.slice(0, 10)));
}

/** The canonical overdue predicate. */
export function isInvoiceOverdue(inv: OverdueInput, today: string): boolean {
  return isOpenInvoiceStatus(inv.status) && n(inv.balanceCents) > 0 && daysPastDue(inv.dueDate, today) > 0;
}

/**
 * The status to DISPLAY / bucket by: OVERDUE when derived-overdue, otherwise the
 * stored status — except a stale stored OVERDUE that is no longer past due (e.g.
 * terms extended) reverts to SENT / PARTIALLY_PAID by amount paid.
 */
export function effectiveInvoiceStatus(inv: OverdueInput, today: string): string {
  const stored = inv.status ?? '';
  if (isInvoiceOverdue(inv, today)) return 'OVERDUE';
  if (stored === 'OVERDUE') return n(inv.amountPaidCents) > 0 ? 'PARTIALLY_PAID' : 'SENT';
  return stored;
}

/** Aging bucket for a days-past-due count (same edges as v_ar_aging). */
export function agingBucketForDays(days: number): AgingBucket {
  if (days <= 0) return 'CURRENT';
  if (days <= 30) return '1-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}

/** Aging bucket for a due date as of the org's `today`. */
export function agingBucketFor(dueDate: string | null | undefined, today: string): AgingBucket {
  return agingBucketForDays(daysPastDue(dueDate, today));
}

/**
 * PostgREST filter fragments (for one `.or()` group) that select an invoice tab
 * consistently with `effectiveInvoiceStatus`. Returned as an `or(...)`-ready
 * inner string so callers can AND it with other groups via `and(or(..),or(..))`.
 */
export function invoiceTabOrFilter(tab: string, today: string): string | null {
  const closed = `(${CLOSED_INVOICE_STATUSES.join(',')})`;
  const notOverdue = `or(due_date.gte.${today},due_date.is.null,balance_cents.lte.0)`;
  switch (tab) {
    case 'OVERDUE':
      return `and(status.not.in.${closed},balance_cents.gt.0,due_date.lt.${today})`;
    case 'SENT':
      return `and(or(status.eq.SENT,and(status.eq.OVERDUE,amount_paid_cents.lte.0)),${notOverdue})`;
    case 'PARTIALLY_PAID':
      return `and(or(status.eq.PARTIALLY_PAID,and(status.eq.OVERDUE,amount_paid_cents.gt.0)),${notOverdue})`;
    default:
      return null; // stored-status tabs (DRAFT / PAID / VOIDED / WRITTEN_OFF) filter by eq
  }
}
