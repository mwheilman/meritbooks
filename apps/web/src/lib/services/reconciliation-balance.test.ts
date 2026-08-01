/**
 * Bank-reconciliation balance + per-line transition guardrail (FPB Wave A).
 *
 * Locks two things that everything downstream depends on:
 *   1. The running-difference-to-$0 math (beginning + cleared net vs statement).
 *   2. The reconcile → finalize → unreconcile per-line state machine — the
 *      migration-065 `reconciliation_id`/`reconciled_at` stamping that makes a
 *      reconciliation auditable, lockable, and undoable.
 *
 * These are the exact UPDATE payloads the API writes to bank_transactions, so
 * testing them here proves the persisted shape matches the finalize/undo intent.
 */

import { describe, it, expect } from 'vitest';
import {
  splitClearedTotals,
  clearedBalanceCents,
  reconciliationDifferenceCents,
  isReconcilable,
  lineClearedUpdate,
  lineFinalizedUpdate,
  lineUnreconciledUpdate,
  isLineCleared,
  isLineLocked,
  type LineReconLink,
} from './reconciliation-balance';

describe('splitClearedTotals', () => {
  it('splits signed line amounts into deposits / payments / net', () => {
    const t = splitClearedTotals([
      { amountCents: 500_00 }, // deposit
      { amountCents: -120_00 }, // check
      { amountCents: -30_50 }, // check
      { amountCents: 0 }, // zero counts as a (non-moving) deposit side
    ]);
    expect(t.depositsCents).toBe(500_00);
    expect(t.paymentsCents).toBe(150_50);
    expect(t.netCents).toBe(349_50);
  });

  it('is zero for no cleared lines', () => {
    expect(splitClearedTotals([])).toEqual({ depositsCents: 0, paymentsCents: 0, netCents: 0 });
  });
});

describe('running difference to $0', () => {
  it('ties exactly when beginning + cleared net equals the statement ending balance', () => {
    // Beginning $1,000.00; clear a $500 deposit and two checks ($120 + $30.50).
    // cleared balance = 100000 + (50000 - 15050) = 134950 → statement must match.
    const clearedLines = [{ amountCents: 500_00 }, { amountCents: -120_00 }, { amountCents: -30_50 }];
    const beginningBalanceCents = 1_000_00;
    const clearedBal = clearedBalanceCents(beginningBalanceCents, clearedLines);
    expect(clearedBal).toBe(1_349_50);

    const diff = reconciliationDifferenceCents({
      statementEndingBalanceCents: 1_349_50,
      beginningBalanceCents,
      clearedLines,
    });
    expect(diff).toBe(0);
    expect(isReconcilable(diff)).toBe(true);
  });

  it('shows the residual when a line is still outstanding (uncleared)', () => {
    // Same statement, but the $500 deposit has NOT cleared yet → short by 500.
    const diff = reconciliationDifferenceCents({
      statementEndingBalanceCents: 1_349_50,
      beginningBalanceCents: 1_000_00,
      clearedLines: [{ amountCents: -120_00 }, { amountCents: -30_50 }],
    });
    expect(diff).toBe(500_00);
    expect(isReconcilable(diff)).toBe(false);
  });

  it('first-ever reconciliation starts from a zero beginning balance', () => {
    const diff = reconciliationDifferenceCents({
      statementEndingBalanceCents: 250_00,
      beginningBalanceCents: 0,
      clearedLines: [{ amountCents: 250_00 }],
    });
    expect(diff).toBe(0);
  });
});

describe('reconcile → finalize → unreconcile line transitions', () => {
  const REC = '11111111-1111-4111-8111-111111111111';
  const AT = '2026-03-31T00:00:00.000Z';

  it('walks a line through cleared → locked → detached, stamping/clearing the link', () => {
    // 0. Unlinked line.
    let link: LineReconLink = { reconciliation_id: null, reconciled_at: null };
    expect(isLineCleared(link)).toBe(false);
    expect(isLineLocked(link)).toBe(false);

    // 1. RECONCILE — check the line off into an open draft (cleared, not locked).
    link = lineClearedUpdate(REC);
    expect(link).toEqual({ reconciliation_id: REC, reconciled_at: null });
    expect(isLineCleared(link)).toBe(true);
    expect(isLineLocked(link)).toBe(false);

    // 2. FINALIZE — lock the cleared line as part of the finalized reconciliation.
    link = lineFinalizedUpdate(REC, AT);
    expect(link).toEqual({ reconciliation_id: REC, reconciled_at: AT });
    expect(isLineCleared(link)).toBe(true);
    expect(isLineLocked(link)).toBe(true);

    // 3. UNRECONCILE — undo: detach the line entirely (auditable un-clear).
    link = lineUnreconciledUpdate();
    expect(link).toEqual({ reconciliation_id: null, reconciled_at: null });
    expect(isLineCleared(link)).toBe(false);
    expect(isLineLocked(link)).toBe(false);
  });

  it('finalize is gated on a $0 difference across the whole line set', () => {
    const clearedLines = [{ amountCents: 800_00 }, { amountCents: -300_00 }];
    const beginningBalanceCents = 0;

    // Statement that does NOT tie → cannot finalize.
    const bad = reconciliationDifferenceCents({
      statementEndingBalanceCents: 400_00,
      beginningBalanceCents,
      clearedLines,
    });
    expect(isReconcilable(bad)).toBe(false);

    // Statement that ties (net 500.00) → may finalize, and every cleared line
    // gets stamped with the finalize timestamp.
    const good = reconciliationDifferenceCents({
      statementEndingBalanceCents: 500_00,
      beginningBalanceCents,
      clearedLines,
    });
    expect(isReconcilable(good)).toBe(true);

    const stamped = clearedLines.map(() => lineFinalizedUpdate(REC, AT));
    expect(stamped.every((l) => isLineLocked(l))).toBe(true);
  });
});
