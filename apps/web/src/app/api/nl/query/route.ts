export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/server';
import { runAiGateway } from '@meritbooks/core-ai';
import {
  buildClassifierPrompt,
  parseClassifierOutput,
  resolveMetric,
  abstainMessage,
  type NlCitation,
} from '@/lib/nl/metric-catalog';

/**
 * POST /api/nl/query — the ANALYTICAL / FP&A lane of the NL copilot.
 *
 * SAFE natural-language → ledger-query. Per docs/FPB-nl-copilot.md (Dimension 5):
 * the model NEVER authors SQL. It routes a prompt to ONE named metric from an
 * allowlist (lib/nl/metric-catalog.ts) and fills TYPED, VALIDATED params. If it
 * picks an unknown metric or the params fail validation, we ABSTAIN — we never
 * fabricate a number. Execution is deterministic against RLS-scoped views, so
 * the tenant wall holds regardless of the prompt (injection-safe by construction).
 *
 * Read-only: the only write is a best-effort audit row to `ai_decisions`.
 */

const NL_FEATURE = 'NL_QUERY';
const NL_MODEL = 'claude-sonnet-4-20250514';

const schema = z.object({
  prompt: z.string().min(2).max(2000),
});

interface NlQueryResponse {
  answer: string;
  metric: string;
  params: Record<string, unknown>;
  rows: unknown[];
  citations: NlCitation[];
  drilldownHref?: string;
}

/** Extract the first text block from a gateway (Anthropic content array) result. */
function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const block = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return block?.text ?? null;
}

function abstain(): NlQueryResponse {
  return { answer: abstainMessage(), metric: '', params: {}, rows: [], citations: [], drilldownHref: undefined };
}

export const POST = apiHandler(schema, async (body, ctx) => {
  // The lane is RLS-scoped to the caller's org; without one we cannot answer.
  if (!ctx.orgId) {
    return NextResponse.json(
      { error: 'No organization context on the session token.', code: 'NO_ORG' },
      { status: 400 },
    );
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY is not configured.', code: 'NO_API_KEY' },
      { status: 503 },
    );
  }

  // The gateway meters/budget-caps to core.* and needs the trusted (admin)
  // client. The actual LEDGER query below runs on ctx.supabase (RLS-scoped) —
  // the model never touches data, and the tenant wall is the database's.
  const admin = createAdminSupabase();

  let gw;
  try {
    gw = await runAiGateway(
      { supabase: admin, anthropicApiKey: apiKey },
      {
        tenant_id: ctx.orgId,
        user_id: ctx.userId,
        module: 'BOOKS',
        feature: NL_FEATURE,
        model: NL_MODEL,
        messages: [{ role: 'user', content: [{ type: 'text', text: buildClassifierPrompt(body.prompt) }] }],
        max_tokens: 400,
      },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Gateway error', code: 'GATEWAY_ERROR' },
      { status: 502 },
    );
  }

  // Budget block / outage → degrade to an honest abstain, never a stack trace.
  if (gw.status === 'blocked' || gw.result == null) {
    const resp = abstain();
    resp.answer =
      'AI is paused for this account right now (budget or availability). ' +
      'You can still open the reports directly from the Reports page.';
    return NextResponse.json<NlQueryResponse>(resp);
  }

  const text = extractText(gw.result);
  const resolved = resolveMetric(parseClassifierOutput(text ?? ''));

  if (!resolved.ok) {
    // Abstain — the prompt maps to no allowlisted metric, or params were invalid.
    await logDecision(admin, {
      orgId: ctx.orgId,
      userId: ctx.userId,
      prompt: body.prompt,
      outcome: { abstained: true, reason: resolved.reason },
      gateway: gw,
    });
    return NextResponse.json<NlQueryResponse>(abstain());
  }

  // Deterministic, RLS-scoped execution. No model SQL ever ran.
  let result;
  try {
    result = await resolved.entry.execute({ supabase: ctx.supabase, orgId: ctx.orgId }, resolved.params);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Query execution failed', code: 'EXEC_ERROR' },
      { status: 500 },
    );
  }

  const params = resolved.params as Record<string, unknown>;
  await logDecision(admin, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    prompt: body.prompt,
    outcome: { metric: resolved.entry.id, params, answer: result.answer, citations: result.citations },
    gateway: gw,
  });

  return NextResponse.json<NlQueryResponse>({
    answer: result.answer,
    metric: resolved.entry.id,
    params,
    rows: result.rows,
    citations: result.citations,
    drilldownHref: result.drilldownHref,
  });
});

/**
 * Best-effort audit to the existing `ai_decisions` rail (Dimension 10 / D10.3 —
 * "who asked what"). Read-only lane, so status stays PROPOSED and nothing posts.
 * Never fails the request.
 */
async function logDecision(
  admin: ReturnType<typeof createAdminSupabase>,
  args: {
    orgId: string;
    userId: string;
    prompt: string;
    outcome: Record<string, unknown>;
    gateway: Awaited<ReturnType<typeof runAiGateway>>;
  },
): Promise<void> {
  try {
    await admin.from('ai_decisions').insert({
      org_id: args.orgId,
      feature: NL_FEATURE,
      model_requested: NL_MODEL,
      model_used: args.gateway.model_used,
      correlation_id: args.gateway.correlation_id,
      input_summary: args.prompt.slice(0, 2000),
      proposed_output: args.outcome,
      status: 'PROPOSED',
      tokens_input: args.gateway.tokens.input,
      tokens_output: args.gateway.tokens.output,
      cost_cents: args.gateway.cost_cents,
      created_by_user: args.userId,
    });
  } catch (e) {
    console.error('[nl-query] decision log failed (non-fatal):', e);
  }
}
