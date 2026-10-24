/**
 * Flux review writes (FPB-financial-reports §5 A-3E.3/A-3E.4).
 *
 * The three flux tables are SELECT-only for members (migration 187). Every write here:
 *   1. runs after the route's permission check (prepare = close_mgmt:view; review, waive,
 *      policy = close_mgmt:manage);
 *   2. re-reads the line through the caller's RLS client and RE-COMPUTES its figures — the
 *      snapshot is the server's, never the client's;
 *   3. goes through `scopedWriter` (org pin + client scope), org_id set / matched.
 * AI provenance (drafted_by_ai / ai_decision_id / ai_citations) is derived here from a
 * verified ai_decisions row — never taken from the request (./ai-provenance). A reviewer's
 * approval pins the exact text it saw (reviewed_explanation_hash; mig-187 CHECK).
 * Nothing here writes the GL or fiscal_periods — the period lock is untouched. Edits are
 * refused once the period is HARD_CLOSE.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { assertOrgRefs, scopedWriter, serviceWriter, writerFor } from '@/lib/db/scoped-writer';
import { loadFluxBoard } from './load';
import {
  EXPLANATION_COLUMNS,
  EXPLANATION_HASH_RE,
  MAX_EXPLANATION,
  explanationFromRow,
  explanationHash,
  isCategory,
  reviewDecision,
  validateSubmission,
  type FluxExplanationRow,
} from './explanations';
import { loadFluxDraftDecision, provenanceFor, verifyFluxDecision, type VerifiedFluxDraft } from './ai-provenance';
import { MIN_WAIVER_REASON } from './gate';
import { parseOverride } from './materiality';
import { FLUX_EXPLAIN_FEATURE } from './ai-draft';
import type {
  ComparisonBasis,
  ExplanationCategory,
  FluxBoard,
  FluxBoardLine,
  FluxDimension,
  FluxExplanation,
  MaterialityOverride,
  ThresholdMode,
} from './types';

export class FluxError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = 'FluxError';
  }
}

export function isFluxError(e: unknown): e is FluxError {
  return e instanceof FluxError;
}

async function boardAndLine(db: SupabaseClient, orgId: string, a: { locationId: string; year: number; month: number; lineKey: string }): Promise<{ board: FluxBoard; line: FluxBoardLine }> {
  const board = await loadFluxBoard(db, orgId, { locationId: a.locationId, year: a.year, month: a.month });
  const line = board.lines.find((l) => l.lineKey === a.lineKey);
  if (!line) throw new FluxError('That flux line has no activity this month.', 404, 'LINE_NOT_FOUND');
  return { board, line };
}

function assertEditable(board: FluxBoard): void {
  if (!board.editable) throw new FluxError(`${board.period.label} is hard-closed — flux documentation is frozen with the books.`, 409, 'PERIOD_CLOSED');
}

// ─────────────────────────────────────────────────────────────────────────────
// Prepare (save draft / submit)
// ─────────────────────────────────────────────────────────────────────────────

export interface SaveExplanationArgs {
  orgId: string;
  userId: string;
  coreUserId: string | null;
  locationId: string;
  year: number;
  month: number;
  lineKey: string;
  explanation: string | null;
  category: ExplanationCategory | null;
  submit: boolean;
  attachmentDocumentId?: string | null;
  /** The AI draft the preparer started from — a CLAIM, verified server-side before use. */
  aiDecisionId?: string | null;
  carriedFromId?: string | null;
}

/** Verify a claimed (or previously stored) AI decision for this exact line; null = not an AI draft. */
async function verifiedDraft(db: SupabaseClient, orgId: string, decisionId: string | null | undefined, target: { locationId: string; periodKey: string; lineKey: string }): Promise<VerifiedFluxDraft | null> {
  if (!decisionId) return null;
  try {
    const row = await loadFluxDraftDecision(writerFor(db), orgId, decisionId);
    return verifyFluxDecision(row, { orgId, ...target });
  } catch (e) {
    console.warn('[flux] ai decision verification failed (treated as not AI-drafted):', e instanceof Error ? e.message : e);
    return null;
  }
}

export async function saveExplanation(db: SupabaseClient, a: SaveExplanationArgs): Promise<FluxExplanation> {
  const { board, line } = await boardAndLine(db, a.orgId, a);
  assertEditable(board);

  let text: string | null = (a.explanation ?? '').trim() || null;
  let category: ExplanationCategory | null = a.category && isCategory(a.category) ? a.category : null;
  if (a.submit) {
    const v = validateSubmission(text, category);
    if (!v.ok) throw new FluxError(v.error, 422, 'INVALID_EXPLANATION');
    text = v.text;
    category = v.category;
  } else if (text && text.length > MAX_EXPLANATION) {
    throw new FluxError(`Keep the explanation under ${MAX_EXPLANATION} characters.`, 422, 'INVALID_EXPLANATION');
  }

  await assertOrgRefs(
    a.orgId,
    [
      { table: 'documents', ids: [a.attachmentDocumentId ?? null], label: 'attachment' },
      { table: 'flux_explanations', ids: [a.carriedFromId ?? null], label: 'carried-forward explanation' },
    ],
    { caller: db },
  );
  const writer = await scopedWriter(db, a.orgId, [a.locationId]);
  const now = new Date().toISOString();
  const prev = line.explanation;
  // Server-side AI provenance: the claimed draft (or the one already on the row), verified
  // for this org + company + month + line, and the text still derived from it.
  const target = { locationId: a.locationId, periodKey: board.period.key, lineKey: line.lineKey };
  const claimed = a.aiDecisionId ? await verifiedDraft(db, a.orgId, a.aiDecisionId, target) : null;
  const verified = claimed ?? (await verifiedDraft(db, a.orgId, prev?.aiDecisionId, target));
  const ai = provenanceFor(verified, text);

  const row = {
    org_id: a.orgId,
    location_id: a.locationId,
    fiscal_period_id: board.fiscalPeriodId,
    period_key: board.period.key,
    line_key: line.lineKey,
    account_id: line.accountId,
    department_id: line.departmentId,
    class_id: line.classId,
    comparison_basis: line.basisUsed,
    current_cents: line.currentCents,
    comparison_cents: line.comparisonCents,
    change_cents: line.changeCents,
    change_pct_bps: line.changePctBps,
    status: a.submit ? 'EXPLAINED' : 'DRAFT',
    explanation: text,
    category,
    attachment_document_id: a.attachmentDocumentId === undefined ? prev?.attachmentDocumentId ?? null : a.attachmentDocumentId,
    drafted_by_ai: ai.draftedByAi,
    ai_decision_id: ai.aiDecisionId,
    ai_citations: ai.aiCitations,
    carried_from_id: a.carriedFromId ?? prev?.carriedFromId ?? null,
    prepared_by: a.userId,
    prepared_by_user_id: a.coreUserId,
    prepared_at: a.submit ? now : prev?.preparedAt ?? null,
    // Any edit clears a prior sign-off (a REVIEWED explanation goes back to EXPLAINED on
    // resubmit / DRAFT on save — never silently stays REVIEWED) and its text pin; a submit
    // also clears the send-back note. While a send-back note stands, keep who sent it back
    // (reviewed_at stays null — not a sign-off).
    reviewed_by: !a.submit && prev?.reviewNote ? prev.reviewedBy : null,
    reviewed_at: null,
    reviewed_explanation_hash: null,
    review_note: a.submit ? null : prev?.reviewNote ?? null,
    updated_at: now,
  };

  const { data, error } = await writer
    .from('flux_explanations')
    .upsert(row, { onConflict: 'org_id,location_id,period_key,line_key' })
    .select(EXPLANATION_COLUMNS)
    .single();
  if (error || !data) throw new FluxError(`Could not save the explanation: ${error?.message ?? 'no row'}`, 500, 'WRITE_FAILED');

  // An accepted AI draft closes its decision-log row (best-effort; never fails the save).
  if (a.submit && ai.aiDecisionId) {
    try {
      await serviceWriter()
        .from('ai_decisions')
        .update({ status: 'APPROVED', disposition_by_user: a.userId, disposition_at: now, disposition_note: 'Accepted into a flux explanation' })
        .eq('id', ai.aiDecisionId)
        .eq('org_id', a.orgId)
        .eq('feature', FLUX_EXPLAIN_FEATURE)
        .eq('status', 'PROPOSED');
    } catch (e) {
      console.warn('[flux] ai decision disposition failed (non-fatal):', e instanceof Error ? e.message : e);
    }
  }
  return explanationFromRow(data as unknown as FluxExplanationRow);
}

// ─────────────────────────────────────────────────────────────────────────────
// Review (approve / send back) — preparer ≠ reviewer
// ─────────────────────────────────────────────────────────────────────────────

export interface ReviewArgs {
  orgId: string;
  userId: string;
  explanationId: string;
  action: 'approve' | 'send_back';
  note?: string | null;
  /**
   * Approve only: `explanationHash` of the text the reviewer SAW (from the board payload).
   * A mismatch with the current row is refused 409 STALE — the preparer changed it.
   */
  explanationHash?: string | null;
  /** The row, if the route already loaded it (for the location-scoped permission check). */
  explanation?: FluxExplanation | null;
}

/**
 * Load one explanation through the caller's RLS client (org + client scope), org-pinned.
 * Routes call this BEFORE the permission check so it runs against the row's own company,
 * never a client-sent one.
 */
export async function loadExplanation(db: SupabaseClient, orgId: string, explanationId: string): Promise<FluxExplanation> {
  const { data: raw, error } = await db.from('flux_explanations').select(EXPLANATION_COLUMNS).eq('id', explanationId).eq('org_id', orgId).maybeSingle();
  if (error) throw new FluxError(error.message, 500, 'READ_FAILED');
  if (!raw) throw new FluxError('Explanation not found.', 404, 'NOT_FOUND');
  return explanationFromRow(raw as unknown as FluxExplanationRow);
}

/** Postgres CHECK violation (23514) — for the review pin, the text changed under the reviewer. */
function isCheckViolation(err: { code?: string; message?: string } | null | undefined): boolean {
  return !!err && (err.code === '23514' || /violates check constraint/i.test(err.message ?? ''));
}

export async function reviewExplanation(db: SupabaseClient, a: ReviewArgs): Promise<FluxExplanation> {
  const e = a.explanation && a.explanation.id === a.explanationId ? a.explanation : await loadExplanation(db, a.orgId, a.explanationId);
  const [y, m] = e.periodKey.split('-').map(Number);
  const { board, line } = await boardAndLine(db, a.orgId, { locationId: e.locationId, year: y, month: m, lineKey: e.lineKey });
  assertEditable(board);

  if (!e.preparedBy || e.preparedBy === a.userId) {
    throw new FluxError('You prepared this explanation — a different person must review it.', 403, 'SOD');
  }
  const now = new Date().toISOString();
  let patch: Record<string, unknown>;
  if (a.action === 'approve') {
    const d = reviewDecision(e, a.userId, line.changeCents);
    if (!d.ok) throw new FluxError(d.error, d.code === 'SOD' ? 403 : 409, d.code);
    const seen = (a.explanationHash ?? '').toLowerCase();
    if (!EXPLANATION_HASH_RE.test(seen)) {
      throw new FluxError('Reload the explanation before approving it.', 422, 'HASH_REQUIRED');
    }
    // Recompute from the row as stored now — never trust the payload's view of the text.
    const current = explanationHash(e.category, e.explanation);
    if (seen !== current) {
      throw new FluxError('The explanation changed since you opened it — reload and review the current text.', 409, 'STALE');
    }
    patch = { status: 'REVIEWED', reviewed_by: a.userId, reviewed_at: now, review_note: (a.note ?? '').trim() || null, reviewed_explanation_hash: current, updated_at: now };
  } else {
    const note = (a.note ?? '').trim();
    if (note.length < 4) throw new FluxError('Say what needs changing (at least 4 characters).', 422, 'NOTE_REQUIRED');
    if (e.status === 'DRAFT') throw new FluxError('This explanation has not been submitted yet.', 409, 'NOT_SUBMITTED');
    // Back to DRAFT; reviewed_by records who sent it back (reviewed_at null — not a sign-off).
    patch = { status: 'DRAFT', reviewed_by: a.userId, reviewed_at: null, review_note: note.slice(0, 1000), reviewed_explanation_hash: null, updated_at: now };
  }

  const writer = await scopedWriter(db, a.orgId, [e.locationId]);
  let q = writer
    .from('flux_explanations')
    .update(patch)
    .eq('id', e.id)
    .eq('org_id', a.orgId)
    .eq('location_id', e.locationId)
    .eq('status', e.status); // optimistic: nobody changed it under us
  // …and nobody re-saved the text (a resubmit keeps status EXPLAINED). The CHECK on
  // reviewed_explanation_hash is the database backstop if the text moves anyway.
  if (e.updatedAt) q = q.eq('updated_at', e.updatedAt);
  const { data, error } = await q.select(EXPLANATION_COLUMNS).maybeSingle();
  if (error && a.action === 'approve' && isCheckViolation(error)) {
    throw new FluxError('The explanation changed since you opened it — reload and review the current text.', 409, 'STALE');
  }
  if (error) throw new FluxError(`Could not record the review: ${error.message}`, 500, 'WRITE_FAILED');
  if (!data) throw new FluxError('This explanation changed while you were reviewing it — reload and try again.', 409, 'CONFLICT');
  return explanationFromRow(data as unknown as FluxExplanationRow);
}

// ─────────────────────────────────────────────────────────────────────────────
// Waiver (controller override of the flux close task)
// ─────────────────────────────────────────────────────────────────────────────

export interface WaiverArgs {
  orgId: string;
  userId: string;
  locationId: string;
  year: number;
  month: number;
  waive: boolean;
  reason?: string | null;
}

export async function setFluxWaiver(db: SupabaseClient, a: WaiverArgs): Promise<{ status: 'OPEN' | 'WAIVED'; reason: string | null }> {
  const board = await loadFluxBoard(db, a.orgId, { locationId: a.locationId, year: a.year, month: a.month });
  assertEditable(board);
  const reason = (a.reason ?? '').trim();
  if (a.waive && reason.length < MIN_WAIVER_REASON) {
    throw new FluxError(`Give the reason for closing without a full flux review (at least ${MIN_WAIVER_REASON} characters).`, 422, 'REASON_REQUIRED');
  }
  const writer = await scopedWriter(db, a.orgId, [a.locationId]);
  const now = new Date().toISOString();
  const values = a.waive
    ? { status: 'WAIVED', waived_reason: reason.slice(0, 1000), waived_by: a.userId, waived_at: now, updated_at: now }
    : { status: 'OPEN', waived_reason: null, waived_by: null, waived_at: null, updated_at: now };

  const { data: existing } = await writer
    .from('flux_reviews')
    .select('id')
    .eq('org_id', a.orgId)
    .eq('location_id', a.locationId)
    .eq('period_key', board.period.key)
    .maybeSingle();
  const res = existing
    ? await writer.from('flux_reviews').update(values).eq('id', (existing as { id: string }).id).eq('org_id', a.orgId)
    : await writer.from('flux_reviews').insert({ org_id: a.orgId, location_id: a.locationId, fiscal_period_id: board.fiscalPeriodId, period_key: board.period.key, ...values });
  if (res.error) throw new FluxError(`Could not record the waiver: ${res.error.message}`, 500, 'WRITE_FAILED');
  return { status: a.waive ? 'WAIVED' : 'OPEN', reason: a.waive ? reason : null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Materiality policy
// ─────────────────────────────────────────────────────────────────────────────

export interface PolicyInput {
  locationId: string | null;
  reviewRequired: boolean;
  thresholdMode: ThresholdMode;
  absThresholdCents: number;
  pctThresholdBps: number;
  comparisonBasis: ComparisonBasis;
  dimension: FluxDimension;
  includePnl: boolean;
  includeBalanceSheet: boolean;
  overrides: MaterialityOverride[];
  excludedAccountIds: string[];
}

export async function saveFluxPolicy(db: SupabaseClient, orgId: string, userId: string, p: PolicyInput): Promise<void> {
  if (!p.includePnl && !p.includeBalanceSheet) throw new FluxError('Include the P&L, the balance sheet, or both.', 422, 'INVALID_POLICY');
  const overrides = p.overrides.map(parseOverride);
  if (overrides.some((o) => o === null)) throw new FluxError('One of the overrides is incomplete.', 422, 'INVALID_POLICY');
  const accountIds = [
    ...p.excludedAccountIds,
    ...p.overrides.filter((o) => o.scope === 'ACCOUNT').map((o) => o.key),
  ];
  const groupIds = p.overrides.filter((o) => o.scope === 'GROUP').map((o) => o.key);
  await assertOrgRefs(
    orgId,
    [
      { table: 'accounts', ids: accountIds, label: 'account' },
      { table: 'account_groups', ids: groupIds, label: 'account group' },
      ...(p.locationId ? [{ schema: 'core' as const, table: 'locations', ids: [p.locationId], label: 'company' }] : []),
    ],
    { caller: db },
  );
  const writer = await scopedWriter(db, orgId, [p.locationId]);
  const now = new Date().toISOString();
  const values = {
    review_required: p.reviewRequired,
    threshold_mode: p.thresholdMode,
    abs_threshold_cents: Math.max(0, Math.trunc(p.absThresholdCents)),
    pct_threshold_bps: Math.max(0, Math.trunc(p.pctThresholdBps)),
    comparison_basis: p.comparisonBasis,
    dimension: p.dimension,
    include_pnl: p.includePnl,
    include_balance_sheet: p.includeBalanceSheet,
    overrides,
    excluded_account_ids: Array.from(new Set(p.excludedAccountIds)),
    updated_by: userId,
    updated_at: now,
  };
  let q = writer.from('flux_materiality_policies').select('id').eq('org_id', orgId);
  q = p.locationId ? q.eq('location_id', p.locationId) : q.is('location_id', null);
  const { data: existing } = await q.maybeSingle();
  const res = existing
    ? await writer.from('flux_materiality_policies').update(values).eq('id', (existing as { id: string }).id).eq('org_id', orgId)
    : await writer.from('flux_materiality_policies').insert({ org_id: orgId, location_id: p.locationId, ...values });
  if (res.error) throw new FluxError(`Could not save the materiality policy: ${res.error.message}`, 500, 'WRITE_FAILED');
}

/** Remove a company's own policy row so it inherits the tenant default again. */
export async function resetCompanyPolicy(db: SupabaseClient, orgId: string, locationId: string): Promise<void> {
  const writer = await scopedWriter(db, orgId, [locationId]);
  const { error } = await writer.from('flux_materiality_policies').delete().eq('org_id', orgId).eq('location_id', locationId);
  if (error) throw new FluxError(`Could not reset the policy: ${error.message}`, 500, 'WRITE_FAILED');
}

