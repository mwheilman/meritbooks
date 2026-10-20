/**
 * AI decision log for Merit Projects → `public.ai_decisions` (migrations 039 + 070).
 *
 * Columns used: org_id, location_id, feature, model_requested, model_used, correlation_id,
 * input_summary, proposed_output (jsonb, carries dedup_key), confidence numeric(5,4) 0..1,
 * reasoning, clarifying_question, status CHECK ('PROPOSED','APPROVED','REJECTED','EXPIRED'),
 * disposition_by_user, disposition_at, disposition_note, tokens_input, tokens_output,
 * cost_cents, created_by_user.
 *
 * RLS: `org_isolation for all using (org_id = get_org_id())`, granted to authenticated, so
 * the RLS client inserts and updates its own org's rows; no service role needed here.
 *
 * Lifecycle (no stale PROPOSED rows; the 070 open-dedup index allows one PROPOSED row per
 * (org, feature, dedup_key)):
 *   propose  → expire the open row with the same dedup_key, insert a new PROPOSED row
 *   approve  → UPDATE that same row to APPROVED (never insert a second row)
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export const DECISION_STATUSES = ['PROPOSED', 'APPROVED', 'REJECTED', 'EXPIRED'] as const;

export interface ProposeDecisionInput {
  orgId: string;
  locationId: string | null;
  feature: string;
  userId: string | null;
  inputSummary: string;
  /** Must carry `dedup_key` when the decision should replace an earlier open one. */
  proposedOutput: Record<string, unknown> & { dedup_key?: string };
  /** 0..1 (stored as numeric(5,4)). */
  confidence: number | null;
  reasoning: string | null;
  modelRequested?: string | null;
  modelUsed?: string | null;
  correlationId?: string | null;
  tokens?: { input: number; output: number };
  costCents?: number;
}

export type DecisionWrite = { ok: true; id: string } | { ok: false; message: string };

function clampConfidence(c: number | null): number | null {
  if (c === null || !Number.isFinite(c)) return null;
  return Math.round(Math.max(0, Math.min(1, c)) * 10_000) / 10_000;
}

/** Insert a PROPOSED row (expiring an open one with the same dedup_key first). Never throws. */
export async function proposeDecision(db: SupabaseClient, input: ProposeDecisionInput): Promise<DecisionWrite> {
  try {
    const dedup = input.proposedOutput.dedup_key;
    if (dedup) {
      await db
        .from('ai_decisions')
        .update({ status: 'EXPIRED', disposition_at: new Date().toISOString(), disposition_note: 'Replaced by a newer proposal' })
        .eq('org_id', input.orgId)
        .eq('feature', input.feature)
        .eq('status', 'PROPOSED')
        .eq('proposed_output->>dedup_key', dedup);
    }
    const { data, error } = await db
      .from('ai_decisions')
      .insert({
        org_id: input.orgId,
        location_id: input.locationId,
        feature: input.feature,
        model_requested: input.modelRequested ?? null,
        model_used: input.modelUsed ?? null,
        correlation_id: input.correlationId ?? null,
        input_summary: input.inputSummary.slice(0, 2000),
        proposed_output: input.proposedOutput,
        confidence: clampConfidence(input.confidence),
        reasoning: input.reasoning ? input.reasoning.slice(0, 4000) : null,
        status: 'PROPOSED',
        tokens_input: input.tokens?.input ?? null,
        tokens_output: input.tokens?.output ?? null,
        cost_cents: input.costCents ?? null,
        created_by_user: input.userId,
      })
      .select('id')
      .single();
    if (error || !data) return { ok: false, message: error?.message ?? 'No row returned' };
    return { ok: true, id: String((data as { id: string }).id) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export interface ApproveDecisionInput {
  id: string;
  orgId: string;
  userId: string | null;
  note: string;
}

/**
 * Mark the SAME row APPROVED (only while it is PROPOSED). Returns whether a row moved.
 * Never throws: the apply already happened; a failed audit update is reported, not fatal.
 */
export async function approveDecision(db: SupabaseClient, input: ApproveDecisionInput): Promise<{ ok: boolean; message?: string }> {
  try {
    const { data, error } = await db
      .from('ai_decisions')
      .update({
        status: 'APPROVED',
        disposition_by_user: input.userId,
        disposition_at: new Date().toISOString(),
        disposition_note: input.note.slice(0, 1000),
      })
      .eq('id', input.id)
      .eq('org_id', input.orgId)
      .eq('status', 'PROPOSED')
      .select('id');
    if (error) return { ok: false, message: error.message };
    return { ok: Array.isArray(data) && data.length > 0 };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
