export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { budgetCtx, budgetError, locationOfVersion } from '@/lib/budgets/route-support';
import { transitionVersion } from '@/lib/budgets/service/versions';
import { resolveActor } from '@/lib/trust/actor';
import { logHumanAction } from '@/lib/trust/action-log';
import { transitionSchema } from '@/lib/validations/budgets';

/**
 * POST /api/budgets/versions/transition — submit | return | approve | lock | delete a version.
 * Approve needs fpa.budgets:approve and is never the submitter (route + DB function + CHECK);
 * approval supersedes the previously published budget and publishes this one atomically.
 */
const PAST = { submit: 'Submitted', return: 'Returned', approve: 'Approved', lock: 'Locked', delete: 'Deleted' } as const;

export const POST = apiHandler(transitionSchema, async (i, ctx) => {
  const loc = await locationOfVersion(ctx.supabase, i.version_id);
  if (loc instanceof NextResponse) return loc;
  const b = await budgetCtx(ctx, loc);
  if (b instanceof NextResponse) return b;
  try {
    const { coreUserId } = i.action === 'approve' ? await resolveActor(ctx.supabase, ctx.userId) : { coreUserId: null };
    const version = await transitionVersion(b, i.version_id, i.action, { note: i.note ?? null, actorCoreUserId: coreUserId });
    await logHumanAction(ctx.supabase, ctx.userId, b.orgId, {
      action: `budget.version.${i.action}`,
      subjectTable: 'budget_plan_versions',
      subjectId: i.version_id,
      summary: `${PAST[i.action]} budget version${version ? ` ${version.label}` : ''}`,
      locationId: loc,
      metadata: { note: i.note ?? null, status: version?.status ?? 'DELETED' },
    }).catch(() => undefined);
    return NextResponse.json({ version });
  } catch (e) {
    return budgetError(e, 'versions/transition');
  }
});
