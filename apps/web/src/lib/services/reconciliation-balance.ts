/**
 * Bank-reconciliation balance math + per-line state transitions — the pure,
 * I/O-free core of the classic controller reconciliation flow (FPB Wave A,
 * Dimensions 4 & 5).
 *
 * The reconciliation identity a controller checks off against is:
 *
 *     cleared balance = beginning balance + Σ(cleared line amounts)
 *     difference      = statement ending balance − cleared balance
 *
 * When the difference hits exactly $0 the book ties to the statement and the
 * reconciliation may be finalized/locked. Everything here is deterministic and
 * unit-testable: no Supabase, no Date.now — the API routes persist what these
 * functions compute (per-line `reconciliation_id`/`reconciled_at`, migration
 * 065), so the same helpers drive both the write path and the test.
 *
 * All amounts are bigint cents. Line amounts are SIGNED: negative = outflow
 * (payment / check), positive = inflow (deposit).
 */

export interface ClearedLine {
  /** Signed cents: negative = outflow (payment), positive = inflow (deposit). */
  amountCents: number;
}

export interface ClearedTotals {
  depositsCents: number; // Σ positive amounts (money in)
  paymentsCents: number; // Σ |negative amounts| (money out)
  netCents: number; // deposits − payments
}

/** Split the checked-off lines into cleared deposits / payments / net. */
export function splitClearedTotals(clearedLines: ClearedLine[]): ClearedTotals {
  let depositsCents = 0;
  let paymentsCents = 0;
  for (const l of clearedLines) {
    const c = Math.trunc(l.amountCents);
    if (c >= 0) depositsCents += c;
    else paymentsCents += -c;
  }
  return { depositsCents, paymentsCents, netCents: depositsCents - paymentsCents };
}

/** Cleared balance = beginning balance + net of the checked-off lines. */
export function clearedBalanceCents(beginningBalanceCents: number, clearedLines: ClearedLine[]): number {
  return Math.trunc(beginningBalanceCents) + splitClearedTotals(clearedLines).netCents;
}

/**
 * Difference to $0: statement ending balance − cleared balance. Zero = ties.
 * A positive difference means the statement shows more than the cleared book
 * balance (lines still to clear); negative means the opposite.
 */
export function reconciliationDifferenceCents(input: {
  statementEndingBalanceCents: number;
  beginningBalanceCents: number;
  clearedLines: ClearedLine[];
}): number {
  return (
    Math.trunc(input.statementEndingBalanceCents) -
    clearedBalanceCents(input.beginningBalanceCents, input.clearedLines)
  );
}

/** A reconciliation may be finalized only when it ties exactly. */
export function isReconcilable(differenceCents: number): boolean {
  return differenceCents === 0;
}

// ── Per-line reconciliation-link state (migration 065 columns) ──────────────────
//
//   reconciliation_id  reconciled_at   meaning
//   ────────────────── ─────────────── ────────────────────────────────────────
//   null               null            not part of any reconciliation
//   <recId>            null            checked off in an OPEN draft (cleared, unlocked)
//   <recId>            <timestamp>      part of a FINALIZED reconciliation (locked)
//
// The transition helpers return exactly the `bank_transactions` UPDATE payloads
// the API writes, so the persisted shape can never drift from the semantics.

export interface LineReconLink {
  reconciliation_id: string | null;
  reconciled_at: string | null;
}

/** Check a line off into an open draft reconciliation (cleared, not yet locked). */
export function lineClearedUpdate(reconciliationId: string): LineReconLink {
  return { reconciliation_id: reconciliationId, reconciled_at: null };
}

/** Lock a cleared line as part of a finalized reconciliation. */
export function lineFinalizedUpdate(reconciliationId: string, atIso: string): LineReconLink {
  return { reconciliation_id: reconciliationId, reconciled_at: atIso };
}

/** Detach a line from its reconciliation (uncheck, or unreconcile/undo). */
export function lineUnreconciledUpdate(): LineReconLink {
  return { reconciliation_id: null, reconciled_at: null };
}

/** A line is "cleared" (checked off) once it links to a reconciliation. */
export function isLineCleared(link: LineReconLink): boolean {
  return link.reconciliation_id != null;
}

/** A line is "locked" once its reconciliation is finalized (stamped `reconciled_at`). */
export function isLineLocked(link: LineReconLink): boolean {
  return link.reconciliation_id != null && link.reconciled_at != null;
}
