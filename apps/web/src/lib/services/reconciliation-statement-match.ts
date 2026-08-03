/**
 * Statement-to-book auto-check-off planner — the pure, I/O-free core that connects
 * a dropped/parsed bank statement (see `lib/bank/statement-parse.ts`) to the
 * per-line reconciliation workspace (Wave A/B).
 *
 * Given the parsed statement lines (what the BANK says cleared) and the book/bank
 * lines already in the period (what the BOOK knows — `bank_transactions`), it pairs
 * them with the SAME documented composite matcher the reconciliation autopilot uses
 * (`compositeMatchScore` — Vendor 40% + Amount 40% + Date 20%) and buckets each pair
 * into a disposition:
 *
 *   • auto   (composite ≥ AUTO_CLEAR_THRESHOLD)   → the book line is cleared into the
 *                                                    reconciliation without a human click.
 *   • review (REVIEW_THRESHOLD ≤ composite < auto) → surfaced with the suggested book
 *                                                    line for a human to accept/reject.
 *   • below review                                 → not a match; the statement line is
 *                                                    reported as "on the statement, no book
 *                                                    entry" (investigate / import via feed).
 *
 * Thresholds are the canonical bank-feed matching cut-lines (CLAUDE.md → Business
 * Rules): ≥90% auto, 70–89% review, <70% flagged. Assignment is GREEDY by descending
 * score and one-to-one (a book line clears at most one statement row and vice-versa),
 * and SIGN-GATED (a deposit never matches a payment of equal magnitude — the composite
 * amount term is sign-blind, so we gate on direction here). Everything is deterministic
 * and unit-tested: no Supabase, no Date.now. The API route persists what this computes.
 */

import { compositeMatchScore, toMatchConfidence } from './reconciliation-match';

/** Canonical cut-lines — a bank line at/above this composite auto-clears. */
export const AUTO_CLEAR_THRESHOLD = 0.9;
/** At/above this (and below auto) it is a suggested match for human review. */
export const REVIEW_THRESHOLD = 0.7;

/** A parsed statement row that is matchable (has a date + a signed amount). */
export interface StatementLineInput {
  /** Stable id from the extraction (ProposedStatementTxn._id). */
  id: string;
  description: string;
  /** Signed cents: negative = money out, positive = money in. */
  amountCents: number;
  /** ISO yyyy-mm-dd. */
  transactionDate: string;
}

/** A book/bank line already in the period, eligible to be cleared. */
export interface BookLineInput {
  id: string;
  description: string | null;
  /** Signed cents: negative = outflow, positive = inflow. */
  amountCents: number;
  transactionDate: string;
}

export interface StatementMatchPair {
  statementId: string;
  statementDescription: string;
  statementAmountCents: number;
  statementDate: string;
  bookLineId: string;
  bookDescription: string;
  bookAmountCents: number;
  bookDate: string;
  /** 0..1 composite. */
  score: number;
  /** Clamped for the numeric(5,4) match_confidence column. */
  confidence: number;
  explanation: string;
}

export interface StatementUnmatched {
  statementId: string;
  description: string;
  amountCents: number;
  transactionDate: string;
  /** Present when there WAS a best candidate but it scored below the review cut. */
  bestScore: number | null;
}

export interface StatementMatchPlan {
  /** composite ≥ AUTO_CLEAR_THRESHOLD — clear these book lines automatically. */
  autoCleared: StatementMatchPair[];
  /** REVIEW ≤ composite < AUTO — suggest to a human, never auto-clear. */
  needsReview: StatementMatchPair[];
  /** Statement rows with no acceptable book match (on the bank, not on the book). */
  unmatchedStatement: StatementUnmatched[];
  /** Book line ids never matched by any statement row (on the book, not on the bank). */
  unmatchedBookLineIds: string[];
}

interface ScoredPair {
  stmt: StatementLineInput;
  book: BookLineInput;
  score: number;
}

/** Same non-zero sign ⇒ same money direction (deposit vs payment). */
function sameDirection(a: number, b: number): boolean {
  if (a === 0 || b === 0) return false;
  return a > 0 === b > 0;
}

/**
 * Build the deterministic auto-check-off plan for a dropped statement.
 *
 * Greedy one-to-one assignment: score every direction-agreeing (statement × book)
 * pair with the documented composite, sort descending, and assign top-down, skipping
 * any pair whose statement row or book line is already taken. Assigned pairs at/above
 * the review cut become auto/review by threshold; everything else is reported as
 * unmatched on its respective side.
 */
export function buildStatementMatchPlan(
  statementLines: StatementLineInput[],
  bookLines: BookLineInput[],
  opts: { autoThreshold?: number; reviewThreshold?: number } = {},
): StatementMatchPlan {
  const autoThreshold = opts.autoThreshold ?? AUTO_CLEAR_THRESHOLD;
  const reviewThreshold = opts.reviewThreshold ?? REVIEW_THRESHOLD;

  // 1. Score all viable (direction-agreeing) pairs.
  const scored: ScoredPair[] = [];
  for (const stmt of statementLines) {
    for (const book of bookLines) {
      if (!sameDirection(stmt.amountCents, book.amountCents)) continue;
      const { score } = compositeMatchScore({
        txnText: stmt.description,
        txnAmountCents: stmt.amountCents,
        txnDate: stmt.transactionDate,
        candidateText: book.description,
        candidateAmountCents: book.amountCents,
        candidateDate: book.transactionDate,
      });
      scored.push({ stmt, book, score });
    }
  }

  // Track the best score each statement row saw, so a below-cut "near miss" can be
  // reported (helps the human tell "no candidate at all" from "close but not sure").
  const bestScoreByStatement = new Map<string, number>();
  for (const p of scored) {
    const prev = bestScoreByStatement.get(p.stmt.id) ?? -1;
    if (p.score > prev) bestScoreByStatement.set(p.stmt.id, p.score);
  }

  // 2. Greedy one-to-one assignment by descending score. Ties break by tighter
  //    amount then closer date via a stable secondary key so the plan is deterministic.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const amtA = Math.abs(Math.abs(a.stmt.amountCents) - Math.abs(a.book.amountCents));
    const amtB = Math.abs(Math.abs(b.stmt.amountCents) - Math.abs(b.book.amountCents));
    if (amtA !== amtB) return amtA - amtB;
    return a.book.id.localeCompare(b.book.id);
  });

  const usedStatement = new Set<string>();
  const usedBook = new Set<string>();
  const autoCleared: StatementMatchPair[] = [];
  const needsReview: StatementMatchPair[] = [];

  for (const p of scored) {
    if (p.score < reviewThreshold) break; // sorted desc — nothing below the cut remains useful
    if (usedStatement.has(p.stmt.id) || usedBook.has(p.book.id)) continue;
    usedStatement.add(p.stmt.id);
    usedBook.add(p.book.id);

    const { score } = compositeMatchScore({
      txnText: p.stmt.description,
      txnAmountCents: p.stmt.amountCents,
      txnDate: p.stmt.transactionDate,
      candidateText: p.book.description,
      candidateAmountCents: p.book.amountCents,
      candidateDate: p.book.transactionDate,
    });
    const pair: StatementMatchPair = {
      statementId: p.stmt.id,
      statementDescription: p.stmt.description,
      statementAmountCents: p.stmt.amountCents,
      statementDate: p.stmt.transactionDate,
      bookLineId: p.book.id,
      bookDescription: p.book.description ?? '',
      bookAmountCents: p.book.amountCents,
      bookDate: p.book.transactionDate,
      score,
      confidence: toMatchConfidence(score),
      explanation: compositeMatchScore({
        txnText: p.stmt.description,
        txnAmountCents: p.stmt.amountCents,
        txnDate: p.stmt.transactionDate,
        candidateText: p.book.description,
        candidateAmountCents: p.book.amountCents,
        candidateDate: p.book.transactionDate,
      }).explanation,
    };
    if (score >= autoThreshold) autoCleared.push(pair);
    else needsReview.push(pair);
  }

  // 3. Report the leftovers on each side.
  const unmatchedStatement: StatementUnmatched[] = statementLines
    .filter((s) => !usedStatement.has(s.id))
    .map((s) => ({
      statementId: s.id,
      description: s.description,
      amountCents: s.amountCents,
      transactionDate: s.transactionDate,
      bestScore: bestScoreByStatement.get(s.id) ?? null,
    }));
  const unmatchedBookLineIds = bookLines.filter((b) => !usedBook.has(b.id)).map((b) => b.id);

  return { autoCleared, needsReview, unmatchedStatement, unmatchedBookLineIds };
}
