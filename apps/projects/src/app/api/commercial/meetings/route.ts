export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { MeetingCreate } from '@/lib/commercial/schemas';
import { cmError, cmWrote } from '@/lib/commercial/server';

/** POST /api/commercial/meetings — schedule a meeting, numbered within its series (OAC #1, #2 …); later ones come from "Next meeting". */
export const POST = route({ access: { cap: 'projects.jobs', action: 'edit' }, mask: false, body: MeetingCreate }, async ({ db, body }) => {
  const pm = db.schema('pm');
  const last = await pm.from('cm_meetings').select('number').eq('job_id', body.jobId).eq('series_key', body.meetingType).order('number', { ascending: false }).limit(1).maybeSingle();
  if (last.error) throw cmError(last.error);
  const number = ((last.data as { number: number } | null)?.number ?? 0) + 1;
  return cmWrote<{ id: string; number: number }>(await pm.from('cm_meetings').insert({
    job_id: body.jobId, meeting_type: body.meetingType, series_key: body.meetingType, number, title: body.title, scheduled_at: body.scheduledAt,
    location_text: body.locationText, agenda: body.agenda,
  }).select('id, number').single());
});
