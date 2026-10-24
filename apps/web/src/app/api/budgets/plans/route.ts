export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { budgetCtx, budgetError, locationOfVersion } from '@/lib/budgets/route-support';
import { transitionPlan, updatePlan } from '@/lib/budgets/service/plans';
import { logHumanAction } from '@/lib/trust/action-log';
import { planActionSchema, planPatchSchema } from '@/lib/validations/budgets';

/**
 * POST  /api/budgets/plans — submit (the owner) | return with a note | approve (never the submitter;
 *       a gap to target needs a note) | reopen a department budget.
 * PATCH — due date and targets (finance), template and gap note (owner or finance).
 */
export const POST = apiHandler(planActionSchema, async (i, ctx) => {
  const loc = await locationOfVersion(ctx.supabase, i.version_id);
  if (loc instanceof NextResponse) return loc;
  const b = await budgetCtx(ctx, loc);
  if (b instanceof NextResponse) return b;
  try {
    const plan = await transitionPlan(b, i.version_id, i.department_id, i.action, { note: i.note ?? null, gapNote: i.gap_note ?? null });
    await logHumanAction(ctx.supabase, ctx.userId, b.orgId, {
      action: `budget.department.${i.action}`,
      subjectTable: 'budget_department_plans',
      subjectId: plan.id,
      summary: `Department budget ${plan.status.toLowerCase()}`,
      locationId: loc,
      metadata: { department_id: i.department_id, note: i.note ?? null },
    }).catch(() => undefined);
    return NextResponse.json({ plan });
  } catch (e) {
    return budgetError(e, 'plans POST');
  }
});

export const PATCH = apiHandler(planPatchSchema, async (i, ctx) => {
  const loc = await locationOfVersion(ctx.supabase, i.version_id);
  if (loc instanceof NextResponse) return loc;
  const b = await budgetCtx(ctx, loc);
  if (b instanceof NextResponse) return b;
  try {
    const plan = await updatePlan(b, i.version_id, i.department_id, {
      dueDate: i.due_date,
      targetRevenueCents: i.target_revenue_cents,
      targetExpenseCents: i.target_expense_cents,
      gapNote: i.gap_note,
      templateKey: i.template_key,
      templateVersion: i.template_version,
    });
    return NextResponse.json({ plan });
  } catch (e) {
    return budgetError(e, 'plans PATCH');
  }
});
