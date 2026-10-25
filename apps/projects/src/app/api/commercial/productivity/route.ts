export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { IsoDate, Uuid } from '@/lib/pm/money/schemas';
import { ProductivityAction } from '@/lib/commercial/schemas';
import { cmRpc, cmWrote } from '@/lib/commercial/server';

/** GET /api/commercial/productivity?jobId=&asOf= — earned vs actual hours by cost code (productivity factor, projected hours, CGC-90). */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, query: z.object({ jobId: Uuid, asOf: IsoDate.optional() }) }, async ({ db, query }) => {
  return { rows: await cmRpc<Array<Record<string, unknown>>>(db, 'cm_labor_productivity', { p_job: query.jobId, p_as_of: query.asOf ?? null }) };
});

/** POST /api/commercial/productivity — record installed quantities (the foreman), or run the weekly fade check. */
export const POST = route({ access: { cap: 'projects.time', action: 'create' }, ops: { fade: { cap: 'projects.time', action: 'approve' } }, mask: false, body: ProductivityAction }, async ({ db, body }) => {
  if (body.op === 'fade') return { alerts: await cmRpc<number>(db, 'cm_run_fade_alerts', { p_job: body.jobId, p_week_start: body.weekStart }) };
  return cmWrote<{ id: string }>(await db.schema('pm').from('cm_installed_quantities').insert({
    job_id: body.jobId, cost_code_id: body.costCodeId, work_date: body.workDate, qty: body.qty, note: body.note,
  }).select('id').single());
});
