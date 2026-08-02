/**
 * Field-weighted ranker for the SEARCH lane.
 *
 * Pure and unit-tested. The retrieval layer hands each candidate a set of
 * FieldMatches (which fields matched, exact vs partial), its date, and its
 * amount; the ranker turns that into a comparable score. Exact number/id
 * matches outrank entity-name matches, which outrank memo/description matches;
 * an exact amount match and recency add tie-breaking weight.
 */

import type { AmountConstraint, FieldMatch, MatchField, FieldKind } from './types';

/** Base weight per (field, kind). Higher = stronger retrieval signal. */
const FIELD_WEIGHTS: Record<MatchField, Record<FieldKind, number>> = {
  number: { exact: 100, partial: 45 },
  name: { exact: 80, partial: 48 },
  memo: { exact: 55, partial: 26 },
  description: { exact: 55, partial: 26 },
  category: { exact: 30, partial: 16 },
  other: { exact: 24, partial: 12 },
};

const AMOUNT_EXACT_BOOST = 60;
const AMOUNT_NEAR_BOOST = 22; // within 1%
const MAX_RECENCY_BOOST = 15;

export interface ScoreInput {
  fieldMatches: FieldMatch[];
  /** ISO yyyy-mm-dd of the hit, or null (undated master). */
  date: string | null;
  /** Hit amount in cents, or null. */
  amountCents: number | null;
  amounts: AmountConstraint;
  /** Reference "now" in epoch ms, injectable for tests. */
  nowMs?: number;
}

function bestByField(matches: FieldMatch[]): FieldMatch[] {
  // Keep only the strongest match per field so repeated partials don't stack.
  const best = new Map<MatchField, FieldMatch>();
  for (const fm of matches) {
    const cur = best.get(fm.field);
    if (!cur) {
      best.set(fm.field, fm);
      continue;
    }
    const curW = FIELD_WEIGHTS[cur.field][cur.kind];
    const newW = FIELD_WEIGHTS[fm.field][fm.kind];
    if (newW > curW) best.set(fm.field, fm);
  }
  return Array.from(best.values());
}

function recencyBoost(date: string | null, nowMs: number): number {
  if (!date) return 0;
  const t = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(t)) return 0;
  const days = Math.max(0, (nowMs - t) / 86_400_000);
  // Full boost for today, decaying to 0 over ~1 year.
  const boost = MAX_RECENCY_BOOST * (1 - days / 365);
  return Math.max(0, boost);
}

function amountBoost(amountCents: number | null, amounts: AmountConstraint): number {
  if (amountCents == null || amounts.exact.length === 0) return 0;
  const abs = Math.abs(amountCents);
  let best = 0;
  for (const target of amounts.exact) {
    if (abs === target) return AMOUNT_EXACT_BOOST;
    const tol = Math.max(1, Math.round(target * 0.01));
    if (Math.abs(abs - target) <= tol) best = Math.max(best, AMOUNT_NEAR_BOOST);
  }
  return best;
}

/** Compute the ranking score for one hit. */
export function computeScore(input: ScoreInput): number {
  const nowMs = input.nowMs ?? Date.now();
  let score = 0;
  for (const fm of bestByField(input.fieldMatches)) {
    score += FIELD_WEIGHTS[fm.field][fm.kind];
  }
  score += amountBoost(input.amountCents, input.amounts);
  score += recencyBoost(input.date, nowMs);
  return Math.round(score * 100) / 100;
}

/** A named text field on a candidate row, for match derivation. */
export interface FieldValue {
  field: MatchField;
  value: string | null | undefined;
}

/**
 * Derive FieldMatches by testing a row's text fields against the query terms
 * and number tokens. Exact = a term/token equals the whole field (case-insens);
 * partial = a term/token is a substring. Model-free and deterministic.
 */
export function deriveFieldMatches(
  fields: FieldValue[],
  terms: string[],
  numberTokens: string[],
): FieldMatch[] {
  const matches: FieldMatch[] = [];
  const needles: Array<{ text: string; isNumber: boolean }> = [
    ...numberTokens.map((t) => ({ text: t.toLowerCase(), isNumber: true })),
    ...terms.map((t) => ({ text: t.toLowerCase(), isNumber: false })),
  ];

  for (const { field, value } of fields) {
    if (!value) continue;
    const hay = value.toLowerCase();
    let bestKind: FieldKind | null = null;
    for (const needle of needles) {
      if (!needle.text) continue;
      if (hay === needle.text) {
        bestKind = 'exact';
        break;
      }
      if (hay.includes(needle.text)) bestKind = bestKind ?? 'partial';
    }
    if (bestKind) matches.push({ field, kind: bestKind });
  }
  return matches;
}
