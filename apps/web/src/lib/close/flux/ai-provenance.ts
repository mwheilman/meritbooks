/**
 * AI-draft provenance for a flux explanation (security review LOW): `drafted_by_ai`,
 * `ai_decision_id` and `ai_citations` are set SERVER-SIDE only. The browser may name the
 * draft it started from (`ai_decision_id`); the server records AI provenance only when:
 *
 *   1. that `ai_decisions` row exists in THIS org, is a FLUX_EXPLAIN decision (PROPOSED or
 *      already APPROVED), and its proposed_output names the same company, month and line;
 *   2. the submitted text derives from the drafted text (identical, or most of the draft's
 *      words survive the edit).
 *
 * The citations come from the decision row (verified against the fact sheet when drafted),
 * never from the request. Pure apart from `loadFluxDraftDecision` (one service-role read,
 * org-pinned).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { FLUX_EXPLAIN_FEATURE } from './ai-draft';

export interface FluxDecisionRow {
  id: string;
  org_id: string;
  feature: string;
  status: string;
  proposed_output: unknown;
}

export interface FluxDraftTarget {
  orgId: string;
  locationId: string;
  periodKey: string;
  lineKey: string;
}

export interface VerifiedFluxDraft {
  decisionId: string;
  explanation: string;
  citations: string[];
}

const CITATION_RE = /^L\d{1,3}$/;

/** Does this decision row belong to this org + company + month + line, as a flux draft? */
export function verifyFluxDecision(row: FluxDecisionRow | null | undefined, t: FluxDraftTarget): VerifiedFluxDraft | null {
  if (!row || row.org_id !== t.orgId || row.feature !== FLUX_EXPLAIN_FEATURE) return null;
  if (row.status !== 'PROPOSED' && row.status !== 'APPROVED') return null;
  const o = row.proposed_output;
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const p = o as Record<string, unknown>;
  if (p.location_id !== t.locationId || p.period_key !== t.periodKey || p.line_key !== t.lineKey) return null;
  if (typeof p.explanation !== 'string' || !p.explanation.trim()) return null;
  const citations = Array.isArray(p.citations)
    ? p.citations.filter((c): c is string => typeof c === 'string' && CITATION_RE.test(c)).slice(0, 20)
    : [];
  return { decisionId: row.id, explanation: p.explanation, citations };
}

function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9$%.]+/)
    .map((w) => w.replace(/^\.+|\.+$/g, ''))
    .filter((w) => w.length >= 3);
}

/** Share of the draft's distinct words still present in the submitted text. */
export const DERIVES_MIN_SHARE = 0.5;

/** The submitted text is the AI draft, or an edit that keeps most of it. */
export function derivesFromDraft(submitted: string | null | undefined, drafted: string): boolean {
  const s = (submitted ?? '').trim();
  if (!s) return false;
  const d = drafted.trim();
  if (s.replace(/\s+/g, ' ') === d.replace(/\s+/g, ' ')) return true;
  const draftWords = new Set(words(d));
  if (draftWords.size === 0) return false;
  const have = new Set(words(s));
  let kept = 0;
  for (const w of draftWords) if (have.has(w)) kept++;
  return kept / draftWords.size >= DERIVES_MIN_SHARE;
}

/** Read one ai_decisions row on the service role, pinned to the org (members can't read it everywhere). */
export async function loadFluxDraftDecision(service: SupabaseClient, orgId: string, decisionId: string): Promise<FluxDecisionRow | null> {
  const { data, error } = await service
    .from('ai_decisions')
    .select('id, org_id, feature, status, proposed_output')
    .eq('id', decisionId)
    .eq('org_id', orgId)
    .eq('feature', FLUX_EXPLAIN_FEATURE)
    .maybeSingle();
  if (error) throw new Error(`ai_decisions: ${error.message}`);
  return (data as FluxDecisionRow | null) ?? null;
}

export interface AiProvenance {
  draftedByAi: boolean;
  aiDecisionId: string | null;
  aiCitations: string[];
}

export const NO_AI: AiProvenance = { draftedByAi: false, aiDecisionId: null, aiCitations: [] };

/**
 * The provenance to store: the claimed (or previously stored) decision, verified for this
 * line, and the text still derived from it. Anything else ⇒ no AI provenance.
 */
export function provenanceFor(verified: VerifiedFluxDraft | null, text: string | null): AiProvenance {
  if (!verified || !derivesFromDraft(text, verified.explanation)) return NO_AI;
  return { draftedByAi: true, aiDecisionId: verified.decisionId, aiCitations: verified.citations };
}
