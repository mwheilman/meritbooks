/**
 * "Explain this ___" — shared types (M7 breadth).
 *
 * A reusable, object-agnostic narrative seam. Given an object KIND + id, the
 * assembler (lib/explain/assemble.ts) gathers the deterministic FACTS about the
 * record — its lines, the accounts touched (by role/type), the source document,
 * who/what proposed and approved it, and the linked records — and produces the
 * structured `Explanation` below. The Core AI gateway may then turn that fact set
 * into a short plain-English paragraph; per CANON it may PHRASE but never invent
 * numbers — every figure originates in these deterministic facts.
 */

/** The object kinds Explain currently understands. Extend as new consumers mount. */
export type ExplainKind = 'JOURNAL_ENTRY' | 'BILL';

export const EXPLAIN_KINDS: ExplainKind[] = ['JOURNAL_ENTRY', 'BILL'];

/** A single "based on" fact — a labeled, human-readable datum drawn from the record. */
export interface ExplainFact {
  label: string;
  value: string;
  /** Render value in the mono/number face (JetBrains Mono). */
  mono?: boolean;
}

/** A navigational anchor to an underlying record the explanation cites. */
export interface ExplainLink {
  label: string;
  href: string;
  /** Optional record-kind hint for iconography. */
  kind?: 'gl_entry' | 'bill' | 'vendor' | 'document' | 'source';
}

/**
 * One posting line, with its debit/credit DIRECTION derived deterministically
 * from the account's normal balance (a debit to a debit-normal account increases
 * it; a credit decreases it — and vice-versa for credit-normal accounts).
 */
export interface ExplainLineFact {
  accountNumber: string;
  accountName: string;
  accountType: string;
  normalBalance: 'DEBIT' | 'CREDIT';
  side: 'debit' | 'credit';
  amountCents: number;
  /** Effect on the account balance, derived from side × normalBalance. */
  effect: 'increase' | 'decrease';
  memo: string | null;
}

/** Who or what proposed / approved the record (the automation + approval trail). */
export interface ExplainActor {
  /** e.g. "AI (BANK_FEED categorizer)", "Manual entry", "Posted by user". */
  label: string;
  /** Optional detail line (timestamp, confidence, model, actor id). */
  detail?: string | null;
}

/**
 * The structured, deterministic explanation. Every value here is computed from
 * the ledger/record — never from the model. This is both the API payload and the
 * fact set handed to the gateway for phrasing.
 */
export interface Explanation {
  kind: ExplainKind;
  id: string;
  /** Short title, e.g. "Journal Entry JE-000123" or "Bill #A-4471 — Acme Supply". */
  title: string;
  /** One-line "what it is" classification. */
  whatItIs: string;
  /** Deterministic "why it posted this way" sentence(s) built from the lines. */
  whyPosted: string;
  status: string;
  totalCents: number;
  balanced: boolean | null;
  lines: ExplainLineFact[];
  proposedBy: ExplainActor | null;
  approvedBy: ExplainActor | null;
  /** Related AI decision-log rows (the automation that touched this record). */
  aiDecisions: {
    id: string;
    feature: string;
    modelUsed: string | null;
    confidence: number | null;
    status: string;
    reasoning: string | null;
    createdAt: string;
  }[];
  /** The "based on" fact list surfaced in the panel. */
  facts: ExplainFact[];
  /** Deep links to the underlying records. */
  links: ExplainLink[];
}

/** The /api/explain response envelope. */
export interface ExplainResult {
  explanation: Explanation;
  /** Plain-English paragraph (AI-phrased or deterministic fallback). */
  narrative: string;
  meta: {
    kind: ExplainKind;
    source: 'ai' | 'deterministic';
    model: string | null;
    decisionId: string | null;
    budgetState: string;
    message?: string | null;
  };
}
