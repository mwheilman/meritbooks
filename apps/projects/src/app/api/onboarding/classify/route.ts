/**
 * POST /api/onboarding/classify — step 1 "What kind of work does {Company} do?"
 *   body: { companyId, description?, tilePackKey?, fileHeaders?, fileName? }
 *   → ClassifyResponse (candidates ≤ 3 with reasons that cite evidence, abstain, ai outcome,
 *     verified evidence quotes, AI-prefilled answers + params for the AI's top pack, decisionId)
 *
 * Rules classify() always. When a description was typed and AI is reachable, the Core gateway
 * runs the forced `propose_configuration` tool; validateAiProposal drops unknown packs and
 * fabricated quotes; mergeAiAndRules combines. One PROPOSED ai_decisions row is logged
 * (source tile | rules | ai | merged) and its id is stored on the onboarding run.
 */
import { z } from 'zod';
import { FEATURE_PACK_CONFIGURE, runAiSafe } from '@/lib/ai/gateway';
import { proposeDecision } from '@/lib/ai/decisions';
import { classifyCompany, decisionPayload } from '@/lib/onboarding/classify';
import { json, requireCompany, withOnboarding } from '@/lib/onboarding/route';
import { ensureRun, patchRun } from '@/lib/onboarding/runs';
import type { ClassifyResponse } from '@/lib/onboarding/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const Body = z.object({
  companyId: z.string().uuid(),
  description: z.string().max(600).optional(),
  tilePackKey: z.string().max(48).nullable().optional(),
  fileHeaders: z.array(z.string().max(120)).max(80).optional(),
  fileName: z.string().max(200).nullable().optional(),
  mode: z.enum(['first', 'change']).default('first'),
});

export async function POST(req: Request) {
  return withOnboarding(req, Body, async (body, ctx) => {
    const company = requireCompany(ctx, body.companyId);
    const description = body.description?.trim() || undefined;
    const input = {
      description,
      tilePackKey: body.tilePackKey ?? undefined,
      companyIndustry: company.industry ?? undefined,
      revRecMethod: company.revRecMethod ?? undefined,
      companyName: company.name,
      fileHeaders: body.fileHeaders?.filter((h) => h.trim() !== ''),
    };

    const out = await classifyCompany(input, (args) =>
      runAiSafe({ orgId: ctx.tenant.orgId, userId: ctx.userId, feature: FEATURE_PACK_CONFIGURE, ...args }));

    const top = out.response.candidates[0];
    const call = out.aiCall;
    const decision = await proposeDecision(ctx.db, {
      orgId: ctx.tenant.orgId,
      locationId: company.id,
      feature: FEATURE_PACK_CONFIGURE,
      userId: ctx.userId,
      inputSummary: [
        `Configure Merit Projects for ${company.name}`,
        body.tilePackKey ? `tile: ${body.tilePackKey}` : null,
        description ? `description: "${description}"` : null,
        input.fileHeaders?.length ? `${input.fileHeaders.length} file headers` : null,
      ].filter(Boolean).join(' · '),
      proposedOutput: decisionPayload(company.id, out, input),
      confidence: top ? top.confidence / 100 : null,
      reasoning: top ? `${top.tileLabel}: ${top.reasons.join('; ')}` : 'Not enough to go on; showing every kind of work.',
      modelRequested: call?.modelRequested ?? null,
      modelUsed: call?.modelUsed ?? null,
      correlationId: call?.correlationId ?? null,
      tokens: call?.tokens,
      costCents: call?.costCents,
    });
    if (!decision.ok) console.warn('[onboarding/classify] decision log failed', decision.message);

    const response: ClassifyResponse = { ...out.response, decisionId: decision.ok ? decision.id : null };

    // resumable: inputs + classification on the company's open run (best effort)
    const { run } = await ensureRun(ctx.db, company.id, { mode: body.mode });
    if (run) {
      await patchRun(ctx.db, run.id, {
        step: 'describe',
        inputs: { ...(run.inputs ?? {}), mode: body.mode, description, tilePackKey: body.tilePackKey ?? null, fileHeaders: input.fileHeaders, fileName: body.fileName ?? null },
        classification: response,
        ai_decision_id: response.decisionId,
      });
    }
    return json(response);
  });
}
