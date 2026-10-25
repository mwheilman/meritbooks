export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { IsoDate, Uuid } from '@/lib/pm/money/schemas';
import { WorkforceAction } from '@/lib/commercial/schemas';
import { cmError, cmWrote } from '@/lib/commercial/server';

/** GET /api/commercial/workforce?companyId=&from= — crew requests, weekly assignments across jobs, and conflicts (double booked, apprentice ratio) (CGC-92). */
export const GET = route({ access: { cap: 'projects.dispatch', action: 'view' }, mask: false, query: z.object({ companyId: Uuid, from: IsoDate.optional() }) }, async ({ db, query }) => {
  const pm = db.schema('pm');
  const from = query.from ?? new Date().toISOString().slice(0, 10);
  const [req, asg, conf] = await Promise.all([
    pm.from('cm_workforce_requests').select('id, job_id, trade, role, headcount, start_week, end_week, status, note').eq('location_id', query.companyId).gte('end_week', from).order('start_week'),
    pm.from('cm_workforce_assignments').select('id, job_id, employee_id, request_id, role, week_start, days, per_diem, travel, status').eq('location_id', query.companyId).gte('week_start', from).order('week_start'),
    pm.from('cm_v_workforce_conflicts').select('*').eq('location_id', query.companyId).gte('week_start', from),
  ]);
  if (req.error) throw cmError(req.error);
  if (asg.error) throw cmError(asg.error);
  return { requests: req.data ?? [], assignments: asg.data ?? [], conflicts: conf.data ?? [] };
});

/** POST /api/commercial/workforce — a PM asks for crew on a job, or the dispatcher books a person for a week. */
export const POST = route({ access: { cap: 'projects.jobs', action: 'edit' }, ops: { assign: { cap: 'projects.dispatch', action: 'edit' } }, mask: false, body: WorkforceAction }, async ({ db, body }) => {
  const pm = db.schema('pm');
  if (body.op === 'request') {
    return cmWrote<{ id: string }>(await pm.from('cm_workforce_requests').insert({
      location_id: body.companyId, job_id: body.jobId, trade: body.trade, role: body.role, headcount: body.headcount, start_week: body.startWeek, end_week: body.endWeek, note: body.note,
    }).select('id').single());
  }
  return cmWrote<{ id: string }>(await pm.from('cm_workforce_assignments').insert({
    location_id: body.companyId, job_id: body.jobId, employee_id: body.employeeId, request_id: body.requestId, role: body.role, week_start: body.weekStart, days: body.days,
    per_diem: body.perDiem, travel: body.travel, note: body.note,
  }).select('id').single());
});
