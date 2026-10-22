/**
 * POST /api/onboarding/plan — step 2 "Here's your workspace"
 *   body: { companyId, packKey, addons[], params?, answers{}, moduleOverrides{}, aiDecisionId?, mode }
 *   → PlanPreview (describePlan cards, job types + stage paths, cost codes, modules with
 *     switches, KPIs, the pack's follow-up questions (prefilled when the AI quoted the user),
 *     add-on options, planHash, and — in mode=change — a diff against the installed plan)
 *
 * Pure compile (no writes besides saving the inputs on the open onboarding run). Every
 * switch or answer change calls this again; the apply route recompiles the same inputs.
 */
import { buildPlan, previewPlan, PlanCompileError } from '@/lib/onboarding/plan';
import { installedPlan } from '@/lib/onboarding/load';
import { RouteError, json, requireCompany, withOnboarding } from '@/lib/onboarding/route';
import { openRun, patchRun } from '@/lib/onboarding/runs';
import { PlanInputsSchema } from '@/lib/onboarding/schemas';
import type { PlanInputs } from '@/lib/onboarding/types';
import { denyUnless } from '@/lib/access/route-guard';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return withOnboarding(req, PlanInputsSchema, async (body, ctx) => {
    requireCompany(ctx, body.companyId);
    const denied = await denyUnless('projects.settings', 'configure', body.companyId); if (denied) return denied;
    const inputs: PlanInputs = {
      companyId: body.companyId, packKey: body.packKey, addons: body.addons, params: body.params,
      answers: body.answers, moduleOverrides: body.moduleOverrides, aiDecisionId: body.aiDecisionId ?? null,
    };
    let plan;
    try {
      plan = buildPlan(inputs);
    } catch (err) {
      if (err instanceof PlanCompileError) throw new RouteError(422, 'PLAN_INVALID', err.message);
      throw err;
    }
    const run = await openRun(ctx.db, body.companyId);
    const installed = body.mode === 'change' ? await installedPlan(ctx.db, body.companyId) : null;
    const preview = previewPlan(plan, inputs, run?.classification ?? null, installed);
    if (run) {
      await patchRun(ctx.db, run.id, { step: 'preview', inputs: { ...(run.inputs ?? {}), plan: inputs }, plan });
    }
    return json(preview);
  });
}
