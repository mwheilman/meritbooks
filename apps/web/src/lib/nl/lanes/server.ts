/**
 * Server-only glue for the PROCESSING lane extractors (P2/P3/P4).
 *
 * Keeps the model call and the audit write in ONE place so every lane routes
 * through the Core AI gateway (metered/budget-capped — no direct Anthropic key)
 * and writes a PROPOSED row to the existing `ai_decisions` rail before anything
 * can be acted on (FPB Dimension 10). The pure extractors take the returned
 * `call`; the route captures gateway meta via `meta()` for the decision log.
 *
 * Server-only — never import into a client component.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { runAiGateway, type GatewayResponse } from '@meritbooks/core-ai';
import type { LaneModelCall } from './extract';

export const NL_LANE_MODEL = 'claude-sonnet-4-20250514';

export interface LaneGateway {
  /** The injected model call the pure extractors consume. Throws on budget block. */
  call: LaneModelCall;
  /** The last gateway response (for the audit trail); null until a call runs. */
  meta(): GatewayResponse | null;
}

function extractText(result: unknown): string {
  if (!Array.isArray(result)) return '';
  const block = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return block?.text ?? '';
}

/** Build a gateway-backed model call for a lane, capturing the response meta. */
export function makeLaneGateway(args: {
  admin: SupabaseClient;
  apiKey: string;
  orgId: string;
  userId: string | null;
  feature: string;
  model?: string;
}): LaneGateway {
  let last: GatewayResponse | null = null;
  const model = args.model ?? NL_LANE_MODEL;
  const call: LaneModelCall = async (userText: string) => {
    const gw = await runAiGateway(
      { supabase: args.admin, anthropicApiKey: args.apiKey },
      {
        tenant_id: args.orgId,
        user_id: args.userId,
        module: 'BOOKS',
        feature: args.feature,
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
        max_tokens: 700,
      },
    );
    last = gw;
    if (gw.status === 'blocked' || gw.result == null) {
      throw new BudgetBlockedError(gw.message ?? 'AI request was blocked (budget or availability).');
    }
    return extractText(gw.result);
  };
  return { call, meta: () => last };
}

/** Thrown when the gateway hard-blocks; the route maps it to HTTP 402. */
export class BudgetBlockedError extends Error {
  readonly code = 'BUDGET_BLOCKED';
}

/**
 * Write a PROPOSED decision to `ai_decisions` (the existing proposal rail — no new
 * table). Best-effort: a logging failure never blocks the proposal. Returns the id.
 */
export async function logLaneDecision(
  admin: SupabaseClient,
  args: {
    orgId: string;
    locationId?: string | null;
    feature: string;
    gateway: GatewayResponse | null;
    inputSummary: string;
    proposedOutput: Record<string, unknown>;
    confidence: number | null;
    clarifyingQuestion: string | null;
    userId: string | null;
  },
): Promise<string | null> {
  try {
    const { data } = await admin
      .from('ai_decisions')
      .insert({
        org_id: args.orgId,
        location_id: args.locationId ?? null,
        feature: args.feature,
        model_requested: NL_LANE_MODEL,
        model_used: args.gateway?.model_used ?? null,
        correlation_id: args.gateway?.correlation_id ?? null,
        input_summary: args.inputSummary.slice(0, 2000),
        proposed_output: args.proposedOutput,
        confidence: args.confidence,
        clarifying_question: args.clarifyingQuestion,
        status: 'PROPOSED',
        tokens_input: args.gateway?.tokens.input ?? null,
        tokens_output: args.gateway?.tokens.output ?? null,
        cost_cents: args.gateway?.cost_cents ?? null,
        created_by_user: args.userId,
      })
      .select('id')
      .single();
    return (data as { id: string } | null)?.id ?? null;
  } catch (e) {
    console.error('[nl-lane] decision log failed (non-fatal):', e);
    return null;
  }
}

/** Shape the gateway meta the client renders (cost/budget/correlation). */
export function gatewayClientMeta(gw: GatewayResponse | null) {
  return gw
    ? {
        status: gw.status,
        modelUsed: gw.model_used,
        costCents: gw.cost_cents,
        budgetState: gw.budget.state,
        correlationId: gw.correlation_id,
        message: gw.message,
      }
    : null;
}
