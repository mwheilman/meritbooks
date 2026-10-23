export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler, apiQueryHandler, type ApiContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { isWriteScopeError } from '@/lib/db/scoped-writer';
import { loadWipSchedule, proposeWipRun, WipRunError } from '@/lib/rev-rec/wip-run-service';

/**
 * RETIRED batch recognition run — now an ALIAS into the one canonical month-end step
 * (FPB-rev-rec-wip §4). There is exactly one recognition mechanism: the WIP run.
 *
 *   GET  ?location_id&as_of=YYYY-MM-DD   summary of what the month's WIP run would book.
 *   POST { location_id, as_of }          saves the month's PROPOSAL (no GL effect). Approval
 *                                        (posting) happens on /api/rev-rec/wip/[runId].
 *
 * Kept so old links / scripts land somewhere correct; new code calls /api/rev-rec/wip.
 */

const AS_OF = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const getSchema = z.object({ location_id: z.string().uuid(), as_of: AS_OF.optional() });
const postSchema = z.object({ location_id: z.string().uuid(), as_of: AS_OF.optional() });

function periodOf(asOf: string | undefined): string {
  if (asOf) return asOf.slice(0, 7);
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}

function fail(e: unknown): NextResponse {
  if (e instanceof WipRunError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
  if (isWriteScopeError(e)) return NextResponse.json({ error: e.message }, { status: 403 });
  throw e;
}

export const GET = apiQueryHandler(getSchema, async (q, ctx: ApiContext) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const guard = await requirePermission(ctx.userId, 'journal_entries', 'view');
  if (!guard.ok) return guard.response;
  try {
    const s = await loadWipSchedule(ctx.supabase, ctx.orgId, { locationId: q.location_id, periodKey: periodOf(q.as_of) });
    return NextResponse.json({
      deprecated: 'Use /api/rev-rec/wip',
      period: s.periodKey,
      asOf: s.asOf,
      totals: s.totals,
      tieOut: s.tieOut,
      currentRun: s.currentRun,
    });
  } catch (e) {
    return fail(e);
  }
});

export const POST = apiHandler(postSchema, async (body, ctx: ApiContext) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const guard = await requirePermission(ctx.userId, 'journal_entries', 'create');
  if (!guard.ok) return guard.response;
  try {
    const res = await proposeWipRun(ctx.supabase, ctx.orgId, {
      locationId: body.location_id, periodKey: periodOf(body.as_of), requestedBy: ctx.userId, source: 'MANUAL',
    });
    return NextResponse.json({ deprecated: 'Use /api/rev-rec/wip', outcome: res.outcome, run: res.run });
  } catch (e) {
    return fail(e);
  }
});
