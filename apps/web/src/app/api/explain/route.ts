export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { runAiGateway } from '@meritbooks/core-ai';
import { apiQueryHandler, type ApiContext } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/server';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import {
  gatherExplanation,
  deterministicExplainNarrative,
  buildExplainFacts,
  EXPLAIN_SYSTEM,
  ExplainNotFoundError,
  type ExplainKind,
} from '@/lib/explain';

/**
 * GET /api/explain?kind=JOURNAL_ENTRY&id=<uuid> — the object-agnostic
 * "Explain this ___" narrative (M7 breadth). Read-only, RLS-scoped.
 *
 * Pipeline mirrors the report flux/variance narrative:
 *   1. DETERMINISTICALLY gather the record's facts from the book of record
 *      (lib/explain) — lines, accounts by type/role, debit/credit DIRECTION
 *      derived from each account's normal balance, the source module/document,
 *      who/what proposed and approved it, and related ai_decisions rows.
 *   2. Hand ONLY those computed facts to the Core AI gateway to PHRASE — it may
 *      not add a number, account, or fact not in the input.
 *   3. Return { explanation, narrative, meta }; `explanation` and every figure
 *      come from OUR gather; the model authors only the prose. If the gateway is
 *      unavailable or budget-blocked, a deterministic narrative is returned so
 *      the panel always renders something truthful.
 */

export const EXPLAIN_MODEL = 'claude-sonnet-4-20250514';
export const EXPLAIN_FEATURE = 'OBJECT_EXPLAIN';

const schema = z.object({
  kind: z.enum(['JOURNAL_ENTRY', 'BILL']),
  id: z.string().uuid(),
});

type Params = z.infer<typeof schema>;

function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

export const GET = apiQueryHandler(schema, async (params: Params, ctx: ApiContext) => {
  const kind = params.kind as ExplainKind;

  // 1. Deterministically gather the facts (RLS-scoped — org isolation at the DB).
  let explanation;
  try {
    explanation = await gatherExplanation(ctx.supabase, kind, params.id);
  } catch (e) {
    if (e instanceof ExplainNotFoundError) {
      return NextResponse.json({ error: e.message, code: 'NOT_FOUND' }, { status: 404 });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to gather record facts', code: 'EXPLAIN_QUERY_ERROR' },
      { status: 500 },
    );
  }

  const fallback = () => deterministicExplainNarrative(explanation);

  // 2. Ask the gateway to PHRASE the facts. Degrade deterministically otherwise.
  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    return NextResponse.json({
      explanation,
      narrative: fallback(),
      meta: { kind, source: 'deterministic', model: null, decisionId: null, budgetState: 'under', message: 'AI provider key not configured' },
    });
  }

  const prompt = `FACTS (already gathered — phrase these, do not alter or add):\n\n${buildExplainFacts(explanation)}\n\nWrite the explanation now.`;
  const admin = createAdminSupabase();

  let gw;
  try {
    gw = await runAiGateway(
      { supabase: admin, anthropicApiKey: apiKey },
      {
        tenant_id: ctx.orgId ?? '',
        user_id: ctx.userId,
        module: 'BOOKS',
        feature: EXPLAIN_FEATURE,
        model: EXPLAIN_MODEL,
        system: EXPLAIN_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        max_tokens: 400,
      },
    );
  } catch (e) {
    return NextResponse.json({
      explanation,
      narrative: fallback(),
      meta: { kind, source: 'deterministic', model: null, decisionId: null, budgetState: 'under', message: e instanceof Error ? e.message : 'Gateway error' },
    });
  }

  if (gw.status === 'blocked' || gw.result == null) {
    return NextResponse.json({
      explanation,
      narrative: fallback(),
      meta: { kind, source: 'deterministic', model: gw.model_used, decisionId: null, budgetState: gw.budget.state, message: gw.message ?? 'AI request blocked' },
    });
  }

  const text = extractText(gw.result);
  const narrative = (text ?? '').trim() || fallback();

  // 3. Audit the AI proposal to the existing decision-log rail (org-scoped, RLS).
  let decisionId: string | null = null;
  try {
    const { data } = await ctx.supabase
      .from('ai_decisions')
      .insert({
        org_id: ctx.orgId,
        feature: EXPLAIN_FEATURE,
        model_requested: EXPLAIN_MODEL,
        model_used: gw.model_used,
        correlation_id: gw.correlation_id,
        input_summary: `Explain ${kind}: ${explanation.title}`.slice(0, 2000),
        proposed_output: { narrative, explanation },
        reasoning: 'AI phrasing of deterministically-gathered record facts; figures authored in code, not by the model.',
        status: 'PROPOSED',
        tokens_input: gw.tokens.input,
        tokens_output: gw.tokens.output,
        cost_cents: gw.cost_cents,
        created_by_user: ctx.userId,
      })
      .select('id')
      .single();
    decisionId = (data as { id: string } | null)?.id ?? null;
  } catch (e) {
    console.error('[explain] decision log failed (non-fatal):', e);
  }

  return NextResponse.json({
    explanation,
    narrative,
    meta: {
      kind,
      source: 'ai',
      model: gw.model_used,
      decisionId,
      budgetState: gw.budget.state,
      message: gw.message,
    },
  });
});
