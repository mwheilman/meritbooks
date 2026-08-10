/**
 * Estimates / quotes — pure, I/O-free logic.
 *
 * An estimate is a NON-POSTING sales document (migration 139). Everything in this
 * module is deterministic and unit-testable: line/subtotal/tax/total arithmetic in
 * bigint CENTS, the per-org sequential estimate-number format, the lifecycle
 * transition rules, and the convert-to-invoice guard that makes a double
 * conversion impossible. Nothing here touches Supabase, the network, or AI.
 */

// ─── Money math (all values are integer cents) ────────────────────────────────

export interface EstimateLineAmountInput {
  quantity: number;
  unit_price_cents: number;
}

export interface EstimateTotals {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

/**
 * Extended line total in cents. Mirrors the invoice-create core exactly
 * (`Math.round(quantity * unit_price_cents)`) so an estimate line and the invoice
 * line it becomes on conversion compute an identical amount.
 */
export function computeLineAmountCents(quantity: number, unitPriceCents: number): number {
  const q = Number(quantity);
  const u = Number(unitPriceCents);
  if (!Number.isFinite(q) || !Number.isFinite(u)) return 0;
  return Math.round(q * u);
}

/**
 * Roll up line amounts + tax into subtotal / tax / total (cents). Tax is a
 * non-negative integer accrual keyed on the estimate; total = subtotal + tax.
 */
export function computeEstimateTotals(
  lines: EstimateLineAmountInput[],
  taxCents = 0,
): EstimateTotals {
  const subtotalCents = lines.reduce(
    (sum, l) => sum + computeLineAmountCents(l.quantity, l.unit_price_cents),
    0,
  );
  const tax = Math.max(0, Math.round(Number(taxCents) || 0));
  return { subtotalCents, taxCents: tax, totalCents: subtotalCents + tax };
}

// ─── Estimate numbering (per-org sequence) ─────────────────────────────────────

/** Next sequence value given the current per-org estimate count. */
export function nextEstimateSeq(existingCount: number | null | undefined): number {
  return (Number(existingCount) || 0) + 1;
}

/**
 * Books-owned estimate number: EST-{YYYYMMDD}-{seq4}, mirroring the invoice
 * (INV-…) and credit-memo (CM-…) conventions. `estimateDate` is an ISO date
 * (YYYY-MM-DD).
 */
export function formatEstimateNumber(estimateDate: string, seq: number): string {
  const dateStr = (estimateDate || '').replace(/-/g, '');
  return `EST-${dateStr}-${String(seq).padStart(4, '0')}`;
}

// ─── Lifecycle + convert guards ────────────────────────────────────────────────

export type EstimateStatus =
  | 'DRAFT'
  | 'SENT'
  | 'ACCEPTED'
  | 'DECLINED'
  | 'EXPIRED'
  | 'CONVERTED';

/** Statuses a user may set by hand (CONVERTED is reached ONLY via conversion). */
export const MANUAL_STATUSES: EstimateStatus[] = [
  'DRAFT',
  'SENT',
  'ACCEPTED',
  'DECLINED',
  'EXPIRED',
];

export type GuardResult = { ok: true } | { ok: false; reason: string };

/**
 * May a user manually move an estimate from `current` to `next`?
 * - A CONVERTED estimate is terminal / locked.
 * - CONVERTED can never be set by hand (only the convert path sets it).
 */
export function canSetStatus(current: string, next: string): GuardResult {
  if (current === 'CONVERTED') {
    return { ok: false, reason: 'A converted estimate is locked and cannot change status.' };
  }
  if (next === 'CONVERTED') {
    return { ok: false, reason: 'Use “Convert to invoice” to convert an estimate.' };
  }
  if (!MANUAL_STATUSES.includes(next as EstimateStatus)) {
    return { ok: false, reason: `Unknown status “${next}”.` };
  }
  return { ok: true };
}

/**
 * The double-convert guard. Conversion is allowed only from DRAFT / SENT /
 * ACCEPTED and only when no invoice has been stamped yet. This is the pure
 * decision; the route ALSO claims the row atomically at the DB so two concurrent
 * requests can never both produce an invoice.
 */
export function canConvertEstimate(
  status: string,
  convertedInvoiceId: string | null | undefined,
): GuardResult {
  if (convertedInvoiceId) {
    return { ok: false, reason: 'This estimate has already been converted to an invoice.' };
  }
  if (status === 'CONVERTED') {
    return { ok: false, reason: 'This estimate has already been converted.' };
  }
  if (status === 'DECLINED') {
    return { ok: false, reason: 'A declined estimate cannot be converted.' };
  }
  if (status === 'EXPIRED') {
    return { ok: false, reason: 'An expired estimate cannot be converted — re-send it first.' };
  }
  return { ok: true };
}
