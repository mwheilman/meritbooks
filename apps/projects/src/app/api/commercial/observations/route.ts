export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { Uuid } from '@/lib/pm/money/schemas';
import { ObservationCreate } from '@/lib/commercial/schemas';
import { cmError, cmWrote } from '@/lib/commercial/server';

const COLS = 'id, job_id, number, obs_type, priority, title, description, hazard, assignee_vendor_id, assignee_name, due_on, status, closed_at, inspection_item_id, created_at';

/** GET /api/commercial/observations?jobId= — quality, safety and commissioning observations (CGC-76). */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, query: z.object({ jobId: Uuid }) }, async ({ db, query }) => {
  const res = await db.schema('pm').from('cm_observations').select(COLS).eq('job_id', query.jobId).neq('status', 'VOID').order('created_at', { ascending: false }).limit(500);
  if (res.error) throw cmError(res.error);
  return { observations: res.data ?? [] };
});

/** POST /api/commercial/observations — record one (numbered per job), assigned to a sub or a person with a due date. */
export const POST = route({ access: { cap: 'projects.jobs', action: 'edit' }, mask: false, body: ObservationCreate }, async ({ db, body }) => {
  return cmWrote<{ id: string; number: string }>(await db.schema('pm').from('cm_observations').insert({
    job_id: body.jobId, obs_type: body.obsType, priority: body.priority, title: body.title, description: body.description, hazard: body.hazard,
    assignee_vendor_id: body.assigneeVendorId, assignee_name: body.assigneeName, due_on: body.dueOn,
  }).select('id, number').single());
});
