export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';

/**
 * Saved / pinned NL questions — GET (list mine) · POST (save) · DELETE (unpin).
 *
 * Persistence rides the EXISTING `ai_decisions` rail (migration 039) with a
 * dedicated discriminator `feature = 'NL_SAVED_QUESTION'` — no new table, no
 * migration. `ai_decisions` is org-isolated by RLS (`org_id = get_org_id()`) and
 * grants select/insert/delete to authenticated, so a saved question can never
 * leak across tenants. We additionally scope to `created_by_user` so a user sees
 * only their own pinned list. status is 'PROPOSED' (nothing is posted; these are
 * bookmarks, not proposals to act on).
 *
 * SAFETY: a saved question is just STORED TEXT. Re-running it goes back through
 * POST /api/nl/route → POST /api/nl/query, i.e. the same classify→allowlist→
 * abstain path with the same RLS wall. Saving text can never widen what the model
 * can reach; it never writes SQL and never touches the ledger.
 *
 * Degrade-safe: every DB error is caught; the endpoints return an empty/ok shape
 * rather than throwing, so the copilot UI keeps working even if the rail is down.
 */

const SAVED_FEATURE = 'NL_SAVED_QUESTION';

interface SavedQuestion {
  id: string;
  prompt: string;
  label: string;
  createdAt: string;
}

/** GET /api/nl/saved — the current user's pinned questions, newest first. */
export const GET = apiQueryHandler(null, async (_params, ctx) => {
  if (!ctx.orgId) return NextResponse.json<{ questions: SavedQuestion[] }>({ questions: [] });
  try {
    const { data, error } = await ctx.supabase
      .from('ai_decisions')
      .select('id, input_summary, proposed_output, created_at')
      .eq('feature', SAVED_FEATURE)
      .eq('created_by_user', ctx.userId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    const questions: SavedQuestion[] = (data ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      const out = (row.proposed_output ?? {}) as Record<string, unknown>;
      const prompt = String(out.prompt ?? row.input_summary ?? '');
      return {
        id: String(row.id),
        prompt,
        label: String(out.label ?? prompt),
        createdAt: String(row.created_at ?? ''),
      };
    });
    return NextResponse.json<{ questions: SavedQuestion[] }>({ questions });
  } catch (e) {
    console.error('[nl-saved] list failed (non-fatal):', e);
    return NextResponse.json<{ questions: SavedQuestion[] }>({ questions: [] });
  }
});

const saveSchema = z.object({
  prompt: z.string().min(2).max(2000),
  label: z.string().min(1).max(120).optional(),
});

/** POST /api/nl/saved — pin a question for later re-run. */
export const POST = apiHandler(saveSchema, async (body, ctx) => {
  if (!ctx.orgId) {
    return NextResponse.json({ error: 'No organization in session', code: 'NO_ORG' }, { status: 400 });
  }
  const prompt = body.prompt.trim();
  const label = (body.label ?? prompt).trim().slice(0, 120);
  try {
    const { data, error } = await ctx.supabase
      .from('ai_decisions')
      .insert({
        org_id: ctx.orgId,
        feature: SAVED_FEATURE,
        input_summary: prompt.slice(0, 2000),
        proposed_output: { kind: 'saved_question', prompt, label },
        status: 'PROPOSED',
        created_by_user: ctx.userId,
      })
      .select('id, created_at')
      .single();
    if (error) throw new Error(error.message);
    const row = (data ?? {}) as Record<string, unknown>;
    return NextResponse.json<{ question: SavedQuestion }>({
      question: { id: String(row.id ?? ''), prompt, label, createdAt: String(row.created_at ?? '') },
    });
  } catch (e) {
    console.error('[nl-saved] save failed:', e);
    return NextResponse.json({ error: 'Could not save the question.', code: 'SAVE_FAILED' }, { status: 500 });
  }
});

const deleteSchema = z.object({ id: z.string().uuid() });

/** DELETE /api/nl/saved?id=<uuid> — unpin one of the current user's questions. */
export const DELETE = apiQueryHandler(deleteSchema, async (params, ctx) => {
  if (!ctx.orgId) {
    return NextResponse.json({ error: 'No organization in session', code: 'NO_ORG' }, { status: 400 });
  }
  try {
    const { error } = await ctx.supabase
      .from('ai_decisions')
      .delete()
      .eq('id', params.id)
      .eq('feature', SAVED_FEATURE)
      .eq('created_by_user', ctx.userId);
    if (error) throw new Error(error.message);
    return NextResponse.json<{ ok: true }>({ ok: true });
  } catch (e) {
    console.error('[nl-saved] delete failed:', e);
    return NextResponse.json({ error: 'Could not remove the question.', code: 'DELETE_FAILED' }, { status: 500 });
  }
});
