/**
 * Flux explanations (FPB-financial-reports §5 A-3E.3) — pure rules.
 *
 *   • `validateSubmission` — text ≥ 10 chars (≤ 4000), a known category.
 *   • `isStale` — the live change moved ≥ max($100, 5% of the explained change).
 *   • `lineStatus` — UNEXPLAINED / DRAFT / EXPLAINED / REVIEWED / STALE for a line.
 *   • `reviewDecision` — preparer ≠ reviewer (the DB CHECK is the backstop), only a
 *     submitted, non-stale explanation can be signed off.
 *   • `carryForwardSuggestion` — last month's story offered again for recurring patterns.
 *   • `explanationHash` — the pin a reviewer signs: sha256 of `category \n explanation`, the
 *     exact expression of the migration-187 CHECK on `reviewed_explanation_hash` (a REVIEWED
 *     row whose text/category changed without a re-review is refused by the database).
 *
 * Server only (node:crypto) — client components import ./types, never this module.
 */

import { createHash } from 'node:crypto';
import type {
  CarryForwardSuggestion,
  ComparisonBasis,
  ExplanationCategory,
  ExplanationStatus,
  FluxExplanation,
  FluxLineStatus,
} from './types';
import { CATEGORY_LABEL, COMPARISON_BASES, EXPLANATION_CATEGORIES } from './types';

export const MIN_EXPLANATION = 10;
export const MAX_EXPLANATION = 4000;
export const STALE_FLOOR_CENTS = 10_000;
export const STALE_SHARE = 0.05;

export function isCategory(v: unknown): v is ExplanationCategory {
  return typeof v === 'string' && (EXPLANATION_CATEGORIES as readonly string[]).includes(v);
}

export function validateSubmission(text: string | null | undefined, category: unknown): { ok: true; text: string; category: ExplanationCategory } | { ok: false; error: string } {
  const t = (text ?? '').trim();
  if (t.length < MIN_EXPLANATION) return { ok: false, error: `Write at least ${MIN_EXPLANATION} characters explaining the change.` };
  if (t.length > MAX_EXPLANATION) return { ok: false, error: `Keep the explanation under ${MAX_EXPLANATION} characters.` };
  if (!isCategory(category)) return { ok: false, error: 'Pick a category for the change.' };
  return { ok: true, text: t, category };
}

/** The live change moved enough since the snapshot that the explanation must be redone. */
export function isStale(snapshotChangeCents: number, liveChangeCents: number): boolean {
  const tolerance = Math.max(STALE_FLOOR_CENTS, Math.round(Math.abs(snapshotChangeCents) * STALE_SHARE));
  return Math.abs(liveChangeCents - snapshotChangeCents) >= tolerance;
}

export function lineStatus(e: Pick<FluxExplanation, 'status' | 'changeCents'> | null | undefined, liveChangeCents: number): FluxLineStatus {
  if (!e) return 'UNEXPLAINED';
  if (e.status === 'DRAFT') return 'DRAFT';
  if (isStale(e.changeCents, liveChangeCents)) return 'STALE';
  return e.status;
}

export type ReviewDecision = { ok: true } | { ok: false; code: 'SOD' | 'NOT_SUBMITTED' | 'STALE' | 'ALREADY_REVIEWED'; error: string };

/** Can `reviewerId` sign off this explanation against the live change? */
export function reviewDecision(
  e: Pick<FluxExplanation, 'status' | 'preparedBy' | 'changeCents'>,
  reviewerId: string,
  liveChangeCents: number,
): ReviewDecision {
  if (e.status === 'REVIEWED') return { ok: false, code: 'ALREADY_REVIEWED', error: 'This explanation is already reviewed.' };
  if (e.status !== 'EXPLAINED') return { ok: false, code: 'NOT_SUBMITTED', error: 'Only a submitted explanation can be reviewed.' };
  if (!e.preparedBy || e.preparedBy === reviewerId) {
    return { ok: false, code: 'SOD', error: 'You prepared this explanation — a different person must review it.' };
  }
  if (isStale(e.changeCents, liveChangeCents)) {
    return { ok: false, code: 'STALE', error: 'The numbers moved since this was explained. Send it back so the preparer can update it.' };
  }
  return { ok: true };
}

const RECURRING: ReadonlySet<ExplanationCategory> = new Set(['TIMING', 'EXPECTED', 'VOLUME', 'PRICE']);

/**
 * Offer last month's explanation as a starting point when the pattern recurs: the latest
 * prior explanation's category is a recurring kind, or the same category was used in two
 * of the last three months. `history` = submitted explanations for the same line_key in
 * the three months before `periodKey` (any order).
 */
export function carryForwardSuggestion(history: FluxExplanation[], periodKey: string): CarryForwardSuggestion | null {
  const prior = history
    .filter((h) => h.periodKey < periodKey && h.status !== 'DRAFT' && h.category && h.explanation)
    .sort((a, b) => b.periodKey.localeCompare(a.periodKey));
  if (prior.length === 0) return null;
  const latest = prior[0];
  const cat = latest.category as ExplanationCategory;
  const sameCat = prior.slice(0, 3).filter((h) => h.category === cat).length;
  let reason: string | null = null;
  if (sameCat >= 2) reason = `${CATEGORY_LABEL[cat]} in ${sameCat} of the last 3 months`;
  else if (RECURRING.has(cat)) reason = `Last month was explained as ${CATEGORY_LABEL[cat].toLowerCase()}`;
  if (!reason) return null;
  return { fromId: latest.id, periodKey: latest.periodKey, category: cat, explanation: latest.explanation as string, reason };
}

/**
 * The hash of the text a reviewer signs off. MUST equal migration 187's
 * `encode(sha256(convert_to(coalesce(category,'') || chr(10) || coalesce(explanation,''), 'UTF8')), 'hex')`.
 */
export function explanationHash(category: string | null | undefined, explanation: string | null | undefined): string {
  return createHash('sha256').update(`${category ?? ''}\n${explanation ?? ''}`, 'utf8').digest('hex');
}

export const EXPLANATION_HASH_RE = /^[0-9a-f]{64}$/;

// ── row mapping ────────────────────────────────────────────────────────────────

export interface FluxExplanationRow {
  id: string;
  location_id: string;
  period_key: string;
  line_key: string;
  account_id: string;
  status: string;
  explanation: string | null;
  category: string | null;
  comparison_basis: string;
  current_cents: number | string;
  comparison_cents: number | string;
  change_cents: number | string;
  change_pct_bps: number | string | null;
  attachment_document_id: string | null;
  drafted_by_ai: boolean | null;
  ai_decision_id: string | null;
  carried_from_id: string | null;
  prepared_by: string | null;
  prepared_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  reviewed_explanation_hash?: string | null;
  updated_at: string | null;
}

export const EXPLANATION_COLUMNS =
  'id, location_id, period_key, line_key, account_id, status, explanation, category, comparison_basis, current_cents, comparison_cents, change_cents, change_pct_bps, attachment_document_id, drafted_by_ai, ai_decision_id, carried_from_id, prepared_by, prepared_at, reviewed_by, reviewed_at, review_note, reviewed_explanation_hash, updated_at';

const n = (v: unknown): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

export function explanationFromRow(r: FluxExplanationRow): FluxExplanation {
  const hash = explanationHash(r.category, r.explanation);
  const pinned = r.reviewed_explanation_hash ?? null;
  let status: ExplanationStatus = r.status === 'REVIEWED' || r.status === 'EXPLAINED' ? r.status : 'DRAFT';
  // Fail closed: a sign-off counts only for the exact text it pinned (the DB CHECK is the
  // guarantor; this keeps a pre-pin or tampered row from reading as REVIEWED).
  if (status === 'REVIEWED' && pinned !== hash) status = 'EXPLAINED';
  const basis: ComparisonBasis = (COMPARISON_BASES as readonly string[]).includes(r.comparison_basis)
    ? (r.comparison_basis as ComparisonBasis)
    : 'PRIOR_MONTH';
  return {
    id: r.id,
    locationId: r.location_id,
    periodKey: r.period_key,
    lineKey: r.line_key,
    accountId: r.account_id,
    status,
    explanation: r.explanation,
    category: isCategory(r.category) ? r.category : null,
    comparisonBasis: basis,
    currentCents: n(r.current_cents),
    comparisonCents: n(r.comparison_cents),
    changeCents: n(r.change_cents),
    changePctBps: r.change_pct_bps == null ? null : n(r.change_pct_bps),
    attachmentDocumentId: r.attachment_document_id,
    draftedByAi: r.drafted_by_ai === true,
    aiDecisionId: r.ai_decision_id,
    carriedFromId: r.carried_from_id,
    preparedBy: r.prepared_by,
    preparedAt: r.prepared_at,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at,
    reviewNote: r.review_note,
    explanationHash: hash,
    reviewedExplanationHash: status === 'REVIEWED' ? pinned : null,
    updatedAt: r.updated_at,
  };
}
