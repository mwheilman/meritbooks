export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler, apiQueryHandler, type ApiContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { isWriteScopeError } from '@/lib/db/scoped-writer';
import { loadWipSchedule, proposeWipRun, WipRunError } from '@/lib/rev-rec/wip-run-service';
import { defaultPeriod, toScheduleView } from '@/lib/rev-rec/wip-view';

/**
 * /api/rev-rec/wip — the month-end WIP schedule and its proposal (FPB-rev-rec-wip §4, §6).
 *
 *   GET  ?location_id&period=YYYY-MM   the schedule (read-only): per-job lines, the proposed
 *                                      entries, the tie-out to GL 1180/2410, prior-month
 *                                      comparison, run status + history, next scheduled run.
 *                                      journal_entries:view.
 *   POST { location_id, period }        compute + save the month's proposal (no GL effect).
 *                                      journal_entries:create — the preparer step; approving
 *                                      (posting) is /api/rev-rec/wip/[runId] with :post.
 *
 * Company-scoped (one company per call — processing is never consolidated).
 */

const PERIOD = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'period must be YYYY-MM');

function errorResponse(e: unknown): NextResponse {
  if (e instanceof WipRunError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
  if (isWriteScopeError(e)) return NextResponse.json({ error: e.message }, { status: 403 });
  throw e;
}

const getSchema = z.object({ location_id: z.string().uuid(), period: PERIOD.optional() });

export const GET = apiQueryHandler(getSchema, async (q, ctx: ApiContext) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const guard = await requirePermission(ctx.userId, 'journal_entries', 'view');
  if (!guard.ok) return guard.response;
  try {
    const schedule = await loadWipSchedule(ctx.supabase, ctx.orgId, { locationId: q.location_id, periodKey: q.period ?? defaultPeriod() });
    return NextResponse.json(await toScheduleView(ctx.supabase, ctx.orgId, schedule));
  } catch (e) {
    return errorResponse(e);
  }
});

const postSchema = z.object({ location_id: z.string().uuid(), period: PERIOD });

export const POST = apiHandler(postSchema, async (body, ctx: ApiContext) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const guard = await requirePermission(ctx.userId, 'journal_entries', 'create');
  if (!guard.ok) return guard.response;
  try {
    const res = await proposeWipRun(ctx.supabase, ctx.orgId, {
      locationId: body.location_id, periodKey: body.period, requestedBy: ctx.userId, source: 'MANUAL',
    });
    return NextResponse.json({
      outcome: res.outcome,
      run: res.run,
      schedule: await toScheduleView(ctx.supabase, ctx.orgId, res.schedule),
    });
  } catch (e) {
    return errorResponse(e);
  }
});
