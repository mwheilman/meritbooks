export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiQueryHandler, type ApiContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { loadWipSchedule, WipRunError } from '@/lib/rev-rec/wip-run-service';
import { defaultPeriod, scheduleCsv, toScheduleView } from '@/lib/rev-rec/wip-view';

/** GET /api/rev-rec/wip/export?location_id&period — the WIP schedule as CSV (journal_entries:view). */

const schema = z.object({
  location_id: z.string().uuid(),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
});

export const GET = apiQueryHandler(schema, async (q, ctx: ApiContext) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const guard = await requirePermission(ctx.userId, 'journal_entries', 'view');
  if (!guard.ok) return guard.response;
  const periodKey = q.period ?? defaultPeriod();
  try {
    const view = await toScheduleView(ctx.supabase, ctx.orgId, await loadWipSchedule(ctx.supabase, ctx.orgId, { locationId: q.location_id, periodKey }));
    const name = `wip-${view.company?.shortCode ?? 'company'}-${periodKey}.csv`.replace(/[^A-Za-z0-9._-]/g, '_');
    return new NextResponse(scheduleCsv(view), {
      status: 200,
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` },
    });
  } catch (e) {
    if (e instanceof WipRunError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
    throw e;
  }
});
