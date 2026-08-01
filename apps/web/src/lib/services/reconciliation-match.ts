/**
 * Reconciliation match scoring — the pure, I/O-free core of the reconciliation
 * autopilot.
 *
 * Implements the documented Bank Feed Matching composite score
 * (CLAUDE.md → Business Rules):
 *
 *     Composite Score = Vendor 40% + Amount 40% + Date 20%
 *
 * A bank statement line (bank_transactions) is scored against a candidate the
 * book already knows about — an open bill it might settle, or an AI/vendor
 * pattern suggestion. The resulting 0..1 confidence is fed through the shared
 * trust engine (scoreToTier) so the machine decides auto / review / escalate
 * consistently with the rest of the platform.
 *
 * Everything here is deterministic and unit-testable: no Supabase, no Date.now.
 */

export interface MatchBreakdown {
  /** 0..1 — weighted composite (Vendor 40% + Amount 40% + Date 20%). */
  score: number;
  vendorScore: number; // 0..1
  amountScore: number; // 0..1
  dateScore: number; // 0..1
  /** Human-readable one-liner for the audit log and the UI tooltip. */
  explanation: string;
}

// Documented composite weights — keep in one place so they can't drift.
export const MATCH_WEIGHTS = { vendor: 0.4, amount: 0.4, date: 0.2 } as const;

/** Lowercase, strip punctuation to spaces, collapse whitespace. */
export function normalizeText(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tokens of length >= 2 (drops noise like single letters). */
function tokens(raw: string | null | undefined): string[] {
  return normalizeText(raw)
    .split(' ')
    .filter((t) => t.length >= 2);
}

/**
 * Vendor/description similarity, 0..1. Blends token overlap (containment) with a
 * whole-string substring bonus so "AMZN MKTP US*2Z" still matches a vendor named
 * "Amazon" weakly but "Home Depot #4021" matches "Home Depot" strongly.
 */
export function vendorSimilarity(
  txnText: string | null | undefined,
  candidateText: string | null | undefined,
): number {
  const a = tokens(txnText);
  const b = tokens(candidateText);
  if (a.length === 0 || b.length === 0) return 0;

  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  for (const t of setB) if (setA.has(t)) shared += 1;

  // Containment against the smaller side: a short vendor name fully present in a
  // long bank description should score high.
  const containment = shared / Math.min(setA.size, setB.size);

  // Whole-normalized-string substring bonus.
  const normA = normalizeText(txnText);
  const normB = normalizeText(candidateText);
  const substr = normA.includes(normB) || normB.includes(normA) ? 0.25 : 0;

  return Math.max(0, Math.min(1, containment * 0.85 + substr));
}

/**
 * Amount closeness, 0..1. Exact = 1; degrades linearly to 0 at a 5% relative
 * difference. Both inputs are absolute cents (sign is handled by the caller).
 */
export function amountSimilarity(txnCents: number, candidateCents: number): number {
  const a = Math.abs(txnCents);
  const b = Math.abs(candidateCents);
  if (a === 0 && b === 0) return 1;
  const denom = Math.max(a, b);
  if (denom === 0) return 0;
  const relDiff = Math.abs(a - b) / denom;
  if (relDiff <= 0.0005) return 1; // within half a basis point → treat as exact
  return Math.max(0, 1 - relDiff / 0.05);
}

/** Whole days between two ISO/date strings (absolute). */
function daysApart(dateA: string, dateB: string): number {
  const ta = new Date(dateA).getTime();
  const tb = new Date(dateB).getTime();
  if (Number.isNaN(ta) || Number.isNaN(tb)) return Number.POSITIVE_INFINITY;
  return Math.abs(ta - tb) / 86_400_000;
}

/**
 * Date closeness, 0..1. Same day = 1; degrades linearly to 0 at 30 days apart
 * (bank posting lag rarely exceeds a few days, but bills can be paid late).
 */
export function dateSimilarity(txnDate: string, candidateDate: string): number {
  const d = daysApart(txnDate, candidateDate);
  if (!Number.isFinite(d)) return 0;
  return Math.max(0, 1 - d / 30);
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/**
 * Composite match score for a bank line against one candidate.
 * Vendor 40% + Amount 40% + Date 20%.
 */
export function compositeMatchScore(input: {
  txnText: string | null | undefined;
  txnAmountCents: number;
  txnDate: string;
  candidateText: string | null | undefined;
  candidateAmountCents: number;
  candidateDate: string;
}): MatchBreakdown {
  const vendorScore = vendorSimilarity(input.txnText, input.candidateText);
  const amountScore = amountSimilarity(input.txnAmountCents, input.candidateAmountCents);
  const dateScore = dateSimilarity(input.txnDate, input.candidateDate);

  const score =
    MATCH_WEIGHTS.vendor * vendorScore +
    MATCH_WEIGHTS.amount * amountScore +
    MATCH_WEIGHTS.date * dateScore;

  const explanation =
    `Vendor ${pct(vendorScore)} · Amount ${pct(amountScore)} · Date ${pct(dateScore)} ` +
    `→ composite ${pct(score)} (40/40/20).`;

  return {
    score: Math.max(0, Math.min(1, score)),
    vendorScore,
    amountScore,
    dateScore,
    explanation,
  };
}

/**
 * Clamp a 0..1 confidence into the numeric(5,4) range the DB column accepts.
 */
export function toMatchConfidence(score: number): number {
  const s = Number.isFinite(score) ? score : 0;
  return Math.max(0, Math.min(0.9999, Math.round(s * 10000) / 10000));
}
