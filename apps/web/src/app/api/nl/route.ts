export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/server';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { runAiGateway } from '@meritbooks/core-ai';

/** Concrete shape of the gateway meta this route reads. Declared locally because the
 * core-ai package's response type does not resolve to a usable shape in this build
 * graph (it collapses to `never`), which silently poisoned every field read below. */
interface GatewayMeta {
  status: string;
  result: unknown;
  message?: string | null;
  correlation_id?: string | null;
  model_used?: string | null;
  cost_cents?: number | null;
  budget?: { state?: string | null } | null;
}
import { logAction } from '@/lib/trust/action-log';
import {
  classifyAndRoute,
  buildClassifierPrompt,
  parseClassification,
  type Classification,
  type NlContext,
} from '@/components/nl/intent';

/**
 * POST /api/nl/route — the Universal NL Command intent classifier + router
 * (FPB-nl-copilot Wave A, Dimension 2).
 *
 * Classifies a plain-English prompt into PROCESSING | ANALYTICAL | NAVIGATION
 * (or ABSTAIN) through the Core AI gateway (no direct Anthropic key; metered +
 * budget-capped). Returns a lane-shaped result the client renders. It NEVER
 * posts, moves money, or executes a query itself:
 *   - PROCESSING → returns a proposal directive; the client drives the LIVE NL
 *     JE composer (which writes ai_decisions) and approves via the existing
 *     gated posting route. Nothing here writes the GL.
 *   - ANALYTICAL → returns the prompt for the client to forward to
 *     POST /api/nl/query (the constrained, read-only allowlist endpoint).
 *   - NAVIGATION → resolves to an in-app route.
 * Every classification is logged to core.action_log (actorType 'AI') with the
 * gateway correlation id — the append-only trust rail.
 *
 * Gated by existing auth only (any authenticated member) per the MVP scope.
 */

const NL_MODEL = 'claude-sonnet-4-20250514';
const NL_FEATURE = 'NL_ROUTER';

const contextSchema = z
  .object({
    surface: z.string().max(120).optional(),
    entityId: z.string().max(120).optional(),
    recordType: z.string().max(120).optional(),
    period: z.string().max(60).optional(),
  })
  .optional();

const schema = z.object({
  prompt: z.string().min(2).max(2000),
  context: contextSchema,
});

/** Extract the text block from a gateway result (Anthropic content array). */
function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const block = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return block?.text ?? null;
}

export const POST = apiHandler(schema, async (body, ctx) => {
  const { userId, orgId, supabase } = ctx;
  if (!orgId) {
    return NextResponse.json(
      { error: 'No organization in session', code: 'NO_ORG' },
      { status: 400 },
    );
  }

  const prompt = body.prompt;
  const context = body.context as NlContext | undefined;
  const apiKey = getAnthropicApiKey() ?? '';

  // Capture gateway meta from the injected classify closure for audit + degraded UI.
  let gateway: GatewayMeta | null = null;

  const classify = async (p: string, c?: NlContext): Promise<Classification> => {
    if (!apiKey) {
      // No key configured → force the rules/degrade path.
      throw new Error('AI provider key not configured');
    }
    const admin = createAdminSupabase();
    const gw = await runAiGateway(
      { supabase: admin, anthropicApiKey: apiKey },
      {
        tenant_id: orgId,
        user_id: userId,
        module: 'BOOKS',
        feature: NL_FEATURE,
        model: NL_MODEL,
        messages: [{ role: 'user', content: [{ type: 'text', text: buildClassifierPrompt(p, c) }] }],
        max_tokens: 500,
      },
    );
    gateway = gw as unknown as GatewayMeta;
    if (gw.status === 'blocked' || gw.result == null) {
      throw new Error(gw.message ?? 'AI request was blocked');
    }
    const text = extractText(gw.result);
    if (!text) throw new Error('The model returned an empty response');
    return parseClassification(text);
  };

  const { result } = await classifyAndRoute(prompt, context, classify);

  // Trust rail: every classification is an AI action → append-only core.action_log.
  // `gateway` is only ever assigned inside the `classify` closure above, so TS
  // control-flow narrows it back to `null` here and the field reads collapse to
  // `never`. Assert the captured type once to restore the real shape.
  const gw = gateway as GatewayMeta | null;
  await logAction(supabase, {
    orgId,
    actorType: 'AI',
    action: 'nl.route.classify',
    subjectTable: 'ai',
    summary: prompt.slice(0, 240),
    confidence: result.confidence || null,
    correlationId: gw?.correlation_id ?? null,
    metadata: {
      lane: result.lane,
      intent: result.intent,
      degraded: result.degraded,
      surface: context?.surface ?? null,
      model_used: gw?.model_used ?? null,
      budget_state: gw?.budget?.state ?? null,
    },
  });

  return NextResponse.json({
    ...result,
    gateway: gw
      ? {
          status: gw.status,
          modelUsed: gw.model_used,
          costCents: gw.cost_cents,
          budgetState: gw.budget?.state ?? null,
          correlationId: gw.correlation_id,
          message: gw.message,
        }
      : null,
  });
});
