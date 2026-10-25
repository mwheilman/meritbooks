export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { TmCreate } from '@/lib/commercial/schemas';
import { cmWrote } from '@/lib/commercial/server';

/**
 * POST /api/commercial/tm — the foreman writes a T&M ticket (hours, materials, equipment).
 * Unit costs are optional and refused for a role without cost access (1120 trigger).
 */
export const POST = route({ access: { cap: 'projects.time', action: 'create' }, mask: ['time_entry', 'estimate'], body: TmCreate }, async ({ db, body }) => {
  const pm = db.schema('pm');
  const t = cmWrote<{ id: string; number: string }>(await pm.from('cm_tm_tickets').insert({
    job_id: body.jobId, work_date: body.workDate, description: body.description, area: body.area, gc_reference: body.gcReference, change_event_id: body.changeEventId,
  }).select('id, number').single());
  if (body.lines.length) {
    const res = await pm.from('cm_tm_ticket_lines').insert(body.lines.map((l, i) => ({
      ticket_id: t.id, kind: l.kind, labor_class: l.labor_class, worker_name: l.worker_name, hours_st: l.hours_st, hours_ot: l.hours_ot, hours_dt: l.hours_dt,
      qty: l.qty, uom: l.uom, description: l.description, equipment_hours: l.equipment_hours, sort: i,
      ...(l.unit_cost_cents !== null ? { unit_cost_cents: l.unit_cost_cents } : {}),
    })));
    if (res.error) {
      // the ticket stays (a draft) so the foreman does not lose it; the lines error says why
      await pm.from('cm_tm_tickets').delete().eq('id', t.id);
      throw new HttpError(422, res.error.message.includes('PM_MONEY_FORBIDDEN') ? 'Leave unit costs blank; the office prices the ticket.' : 'The ticket lines were not saved. Check hours and quantities.', 'PM_TM_LINES');
    }
  }
  return t;
});
