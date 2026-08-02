/**
 * AI-drafted adjusting-entry classifier (FPB Bank Reconciliation, Dimension 6 /
 * D6.1–D6.2 — "help me find & book the difference"; feature `RECON_ADJUSTMENT`).
 *
 * A reconciliation ties when the book equals the bank. The lines that keep it from
 * tying are almost always a small, well-known family: a bank service charge, an
 * interest credit, an NSF/returned-item fee, or a sub-dollar FX/rounding wobble.
 * This is the PURE, I/O-free core that looks at an unmatched bank line (its
 * description + signed amount) and PROPOSES a categorized adjusting entry a human
 * can approve — it NEVER posts, and it NEVER guesses.
 *
 * The canon line that governs this file (CANON-ANCHOR §3, and the task):
 *   "AI proposes FACTS; a human approves; a reconciliation forced to zero by a plug
 *    is NOT a reconciliation."
 * So the classifier is deliberately CONSERVATIVE: a line only earns a proposal when
 * its own description (and, for rounding, its own sub-dollar magnitude) gives a
 * *cause*. A line with no explainable cause returns `null` — it stays an UNEXPLAINED
 * line, surfaced to the human, never silently absorbed by a plug. There is no
 * "make it zero" path anywhere in this module.
 *
 * The output maps onto the vetted `/api/reconciliation/adjustment` domain
 * (`bank_fee | interest | other`) so approval reuses the balanced, role-resolved,
 * period-locked posting path — the classifier adds intelligence, not a new money path.
 *
 * All amounts are bigint cents. Bank-line amounts are SIGNED (negative = money out,
 * positive = money in), matching `bank_transactions.amount_cents`.
 */

import type { AdjustmentType, CashEffect } from './reconciliation-adjustment';
import type { AccountRoleKey } from '@/lib/posting/account-roles';

/** The `ai_decisions.feature` key the control plane governs for this proposer. */
export const RECON_ADJUSTMENT_FEATURE = 'RECON_ADJUSTMENT';

/** A finer-grained cause than the 3-way posting domain, for display + reasoning. */
export type AdjustmentCategory = 'bank_fee' | 'interest' | 'nsf' | 'fx_rounding';

/** The minimal shape of a bank line the classifier reasons over. */
export interface ClassifiableBankLine {
  id: string;
  description: string | null;
  /** SIGNED cents: negative = outflow, positive = inflow. */
  amountCents: number;
}

/**
 * A proposed adjusting entry. It is ADVISORY — a human must approve it, at which
 * point the approval route posts it through `postJournalEntry`. `offsetRole` names
 * the account role the approve path should resolve (null ⇒ the human must choose
 * the offset, e.g. which income account interest lands in).
 */
export interface AdjustmentProposal {
  sourceTransactionId: string;
  category: AdjustmentCategory;
  /** Maps onto /api/reconciliation/adjustment's `adjustment_type`. */
  adjustmentType: AdjustmentType;
  cashEffect: CashEffect;
  /** Positive magnitude in cents (the sign is carried by `cashEffect`). */
  amountCents: number;
  /** The offset account role to auto-resolve, or null ⇒ human picks the account. */
  offsetRole: AccountRoleKey | null;
  suggestedMemo: string;
  /** 0–1 heuristic confidence (keyword strength). Advisory only. */
  confidence: number;
  reasoning: string;
}

/** Keyword banks — lowercase, matched as substrings against the description. */
const FEE_KEYWORDS = [
  'service charge',
  'service fee',
  'monthly fee',
  'maintenance fee',
  'account fee',
  'bank fee',
  'wire fee',
  'wire transfer fee',
  'overdraft',
  'od fee',
  'atm fee',
  'analysis charge',
  'account analysis',
  'card fee',
  'stop payment',
  'check printing',
  'foreign transaction fee',
];

const NSF_KEYWORDS = [
  'nsf',
  'non-sufficient',
  'nonsufficient',
  'insufficient funds',
  'returned check',
  'return item',
  'returned item',
  'chargeback',
];

const INTEREST_KEYWORDS = [
  'interest',
  'int pd',
  'int paid',
  'credit interest',
  'interest earned',
  'interest payment',
  'dividend',
];

const ROUNDING_KEYWORDS = ['rounding', 'round', ' fx', 'foreign exchange', 'currency', 'adjustment', 'adj ', 'difference'];

/** Default: a residual is only "FX/rounding-small" at or under $1.00. */
export const DEFAULT_ROUNDING_THRESHOLD_CENTS = 100;

function hasKeyword(haystack: string, keywords: string[]): boolean {
  return keywords.some((k) => haystack.includes(k));
}

/**
 * Classify one unmatched bank line into a proposed adjusting entry, or `null` when
 * there is no explainable cause (⇒ it must remain a visible UNEXPLAINED line).
 *
 * Conservative by design: outflow-only for fees/NSF, inflow-only for interest, and
 * FX/rounding only for a sub-threshold magnitude that ALSO carries a rounding-ish
 * description — never a bare residual (that would be a plug).
 */
export function classifyBankLine(
  line: ClassifiableBankLine,
  opts: { roundingThresholdCents?: number } = {},
): AdjustmentProposal | null {
  const amount = Math.trunc(line.amountCents);
  if (!Number.isFinite(amount) || amount === 0) return null;

  const desc = ` ${(line.description ?? '').toLowerCase().trim()} `;
  const magnitude = Math.abs(amount);
  const isOutflow = amount < 0;
  const isInflow = amount > 0;
  const roundingThreshold = opts.roundingThresholdCents ?? DEFAULT_ROUNDING_THRESHOLD_CENTS;

  // 1. NSF / returned-item fee (a charge) — outflow only.
  if (isOutflow && hasKeyword(desc, NSF_KEYWORDS)) {
    return {
      sourceTransactionId: line.id,
      category: 'nsf',
      adjustmentType: 'bank_fee',
      cashEffect: 'decrease',
      amountCents: magnitude,
      offsetRole: 'MERCHANT_FEE_EXPENSE',
      suggestedMemo: cleanMemo(line.description) || 'NSF / returned-item fee',
      confidence: 0.8,
      reasoning:
        'Description matches an NSF / returned-item fee and the line is an outflow — proposing DR Bank Fees / CR Cash. Approve to book; do not plug.',
    };
  }

  // 2. Bank service charge / fee — outflow only.
  if (isOutflow && hasKeyword(desc, FEE_KEYWORDS)) {
    return {
      sourceTransactionId: line.id,
      category: 'bank_fee',
      adjustmentType: 'bank_fee',
      cashEffect: 'decrease',
      amountCents: magnitude,
      offsetRole: 'MERCHANT_FEE_EXPENSE',
      suggestedMemo: cleanMemo(line.description) || 'Bank service charge',
      confidence: 0.85,
      reasoning:
        'Description matches a bank service charge / fee and the line is an outflow — proposing DR Bank Fees / CR Cash.',
    };
  }

  // 3. Interest credit — inflow only. Offset is an income account the human picks.
  if (isInflow && hasKeyword(desc, INTEREST_KEYWORDS)) {
    return {
      sourceTransactionId: line.id,
      category: 'interest',
      adjustmentType: 'interest',
      cashEffect: 'increase',
      amountCents: magnitude,
      offsetRole: null,
      suggestedMemo: cleanMemo(line.description) || 'Interest income',
      confidence: 0.85,
      reasoning:
        'Description matches interest earned and the line is an inflow — proposing DR Cash / CR Interest Income. Choose the income account to book.',
    };
  }

  // 4. Sub-dollar FX / rounding — small magnitude AND a rounding-ish description.
  //    This is the ONLY residual-shaped case, and it still requires a stated cause;
  //    a bare unexplained difference is never proposed (that would be a plug).
  if (magnitude <= roundingThreshold && hasKeyword(desc, ROUNDING_KEYWORDS)) {
    return {
      sourceTransactionId: line.id,
      category: 'fx_rounding',
      adjustmentType: 'other',
      cashEffect: isOutflow ? 'decrease' : 'increase',
      amountCents: magnitude,
      // A charge lands in bank fees; a credit needs a chosen income/offset account.
      offsetRole: isOutflow ? 'MERCHANT_FEE_EXPENSE' : null,
      suggestedMemo: cleanMemo(line.description) || 'FX / rounding adjustment',
      confidence: 0.55,
      reasoning:
        'Sub-dollar amount with a rounding/FX description — proposing a small balanced correction. Review before posting.',
    };
  }

  // No explainable cause → NOT a proposal. Stays a visible unexplained line.
  return null;
}

export interface DraftResult {
  proposals: AdjustmentProposal[];
  /** Lines the classifier could NOT explain — these must stay visible, never plugged. */
  unexplainedLineIds: string[];
}

/**
 * Draft proposals across a set of unmatched lines. Pure: it partitions the lines
 * into explainable proposals and unexplained leftovers. It does NOT decide the
 * reconciliation ties — that stays the balance module's job — it only supplies the
 * candidate adjustments and names what remains unexplained.
 */
export function draftAdjustmentProposals(
  lines: ClassifiableBankLine[],
  opts: { roundingThresholdCents?: number } = {},
): DraftResult {
  const proposals: AdjustmentProposal[] = [];
  const unexplainedLineIds: string[] = [];
  for (const line of lines) {
    const p = classifyBankLine(line, opts);
    if (p) proposals.push(p);
    else unexplainedLineIds.push(line.id);
  }
  // Surface the highest-confidence, largest items first.
  proposals.sort((a, b) => b.confidence - a.confidence || b.amountCents - a.amountCents);
  return { proposals, unexplainedLineIds };
}

/** Trim a raw bank description into a tidy memo (≤120 chars, collapsed whitespace). */
function cleanMemo(description: string | null): string {
  if (!description) return '';
  return description.replace(/\s+/g, ' ').trim().slice(0, 120);
}
