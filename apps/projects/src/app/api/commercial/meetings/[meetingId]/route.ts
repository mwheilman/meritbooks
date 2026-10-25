export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { MeetingAction } from '@/lib/commercial/schemas';
import { cmRpc, cmWrote, loadAttendees } from '@/lib/commercial/server';

/** GET /api/commercial/meetings/:id — attendees (with who accepted the minutes). */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false }, async ({ db, params }) => {
  return { attendees: await loadAttendees(db, params.meetingId!) };
});

/**
 * POST /api/commercial/meetings/:id — the next meeting in the series (open items carry forward,
 * CGC-68), distribute the minutes, write minutes, add an attendee or an item, close an item.
 */
export const POST = route({ access: { cap: 'projects.jobs', action: 'edit' }, mask: false, body: MeetingAction }, async ({ db, body, params }) => {
  const id = params.meetingId!;
  const pm = db.schema('pm');
  switch (body.op) {
    case 'next':
      return { id: await cmRpc<string>(db, 'cm_meeting_next', { p_meeting: id, p_scheduled_at: body.scheduledAt }) };
    case 'distribute':
      return { id: await cmRpc<string>(db, 'cm_meeting_distribute', { p_meeting: id }) };
    case 'minutes':
      return cmWrote<{ id: string }>(await pm.from('cm_meetings').update({ minutes: body.minutes, status: 'MINUTES_DRAFT' }).eq('id', id).in('status', ['SCHEDULED', 'IN_PROGRESS', 'MINUTES_DRAFT']).select('id').single());
    case 'attendee':
      return cmWrote<{ id: string }>(await pm.from('cm_meeting_attendees').insert({ meeting_id: id, name: body.name, company: body.company, email: body.email, role: body.role }).select('id').single());
    case 'item':
      return cmWrote<{ id: string; item_no: string }>(await pm.from('cm_meeting_items').insert({
        origin_meeting_id: id, topic: body.topic, description: body.description, owner_name: body.ownerName, owner_company: body.ownerCompany, due_on: body.dueOn,
      }).select('id, item_no').single());
    case 'item_status':
      return cmWrote<{ id: string }>(await pm.from('cm_meeting_items').update({
        status: body.status, closed_in_meeting_id: body.status === 'CLOSED' ? id : null, closed_at: body.status === 'CLOSED' ? new Date().toISOString() : null,
      }).eq('id', body.itemId).select('id').single());
  }
});
