/**
 * POST /api/onboarding/apply — "Set up {Company}"
 *   body: PlanInputs + { expectedPlanHash, mode }
 *   → ApplyResponse { installId, planHash, decisionApproved, nextStep }
 *
 * Recompiles from the same inputs (never trusts a client-sent plan), refuses if the hash
 * differs from what the user previewed (409), then ONE call to
 *   pm.apply_pack_plan(p_plan := plan + {ai_decision_id}, p_role := 'primary')
 * which is idempotent (same plan_hash → no-op), never deletes (dropped rows are
 * deactivated), and flips the company's IN_PROGRESS onboarding run to APPLIED/bring_work.
 * Then the SAME ai_decisions row is updated to APPROVED, and module switches are recorded
 * as pm.pack_overrides (RFC 6901 pointers) so a later re-plan keeps them.
 */
import { approveDecision } from '@/lib/ai/decisions';
import { getMe } from '@/lib/pm/people';
import { buildApplyPayload, buildPlan, PlanCompileError } from '@/lib/onboarding/plan';
import { RouteError, dbError, json, requireCompany, withOnboarding } from '@/lib/onboarding/route';
import { openRun } from '@/lib/onboarding/runs';
import { ApplySchema } from '@/lib/onboarding/schemas';
import type { ApplyResponse, PlanInputs } from '@/lib/onboarding/types';

export const dynamic = 'force-dynamic';

const SETUP_ROLES: ReadonlySet<string> = new Set(['owner', 'company_admin', 'admin', 'ops_manager', 'controller']);

export async function POST(req: Request) {
  return withOnboarding(req, ApplySchema, async (body, ctx) => {
    const company = requireCompany(ctx, body.companyId);
    // Configuring a company's workspace is an admin action (owner / admin / ops lead).
    const me = await getMe(ctx.db, ctx.userId ?? '');
    if (!me.role || !SETUP_ROLES.has(me.role)) {
      throw new RouteError(403, 'SETUP_NOT_ALLOWED', 'Only an owner or admin can set up a company. Ask them to finish this step, or to change your role in Books.');
    }
    const inputs: PlanInputs = {
      companyId: body.companyId, packKey: body.packKey, addons: body.addons, params: body.params,
      answers: body.answers, moduleOverrides: body.moduleOverrides,
    };
    let plan;
    try {
      plan = buildPlan(inputs);
    } catch (err) {
      if (err instanceof PlanCompileError) throw new RouteError(422, 'PLAN_INVALID', err.message);
      throw err;
    }
    if (plan.plan_hash !== body.expectedPlanHash) {
      throw new RouteError(409, 'PLAN_CHANGED', 'The workspace changed since you reviewed it. Look it over once more, then set it up.');
    }

    const run = await openRun(ctx.db, company.id);
    const decisionId = body.aiDecisionId ?? run?.ai_decision_id ?? null;
    const payload = buildApplyPayload(plan, decisionId);

    const { data: installId, error } = await ctx.db.schema('pm').rpc('apply_pack_plan', { p_plan: payload, p_role: 'primary' });
    if (error || !installId) throw dbError(error, 'Setting up the workspace');

    let decisionApproved = false;
    if (decisionId) {
      const proposedTop = run?.classification?.candidates[0]?.packKey ?? null;
      const r = await approveDecision(ctx.db, {
        id: decisionId,
        orgId: ctx.tenant.orgId,
        userId: ctx.userId,
        note: [
          `Applied ${plan.primary_pack.key}@${plan.primary_pack.version}`,
          plan.addon_packs.length ? `with ${plan.addon_packs.map((a) => a.key).join(', ')}` : null,
          proposedTop && proposedTop !== plan.primary_pack.key ? `(user chose it over ${proposedTop})` : '(as proposed)',
          `plan ${plan.plan_hash.slice(0, 12)}`,
        ].filter(Boolean).join(' '),
      });
      decisionApproved = r.ok;
      if (!r.ok && r.message) console.warn('[onboarding/apply] decision approve failed', r.message);
    }

    // module switches → pack_overrides (replace this install's /modules/* pointers). Best effort.
    const overrides = plan.module_overrides ?? {};
    const pm = ctx.db.schema('pm');
    await pm.from('pack_overrides').delete().eq('install_id', installId as string).like('json_pointer', '/modules/%');
    const rows = Object.entries(overrides).map(([m, on]) => ({
      install_id: installId as string, json_pointer: `/modules/${m}`, op: 'replace', value: on, reason: 'Switched during onboarding',
    }));
    if (rows.length > 0) {
      const { error: ovErr } = await pm.from('pack_overrides').insert(rows);
      if (ovErr) console.warn('[onboarding/apply] pack_overrides insert failed', ovErr.message);
    }

    const res: ApplyResponse = { installId: installId as string, planHash: plan.plan_hash, decisionApproved, nextStep: 'bring_work' };
    return json(res);
  });
}
