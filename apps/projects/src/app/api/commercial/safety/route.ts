export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { Uuid } from '@/lib/pm/money/schemas';
import { SafetyAction } from '@/lib/commercial/schemas';
import { cmError, cmRpc, cmWrote } from '@/lib/commercial/server';

/** GET /api/commercial/safety?jobId= — toolbox talks, JHAs and (for those who may see them) incidents on a job. */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, query: z.object({ jobId: Uuid }) }, async ({ db, query }) => {
  const pm = db.schema('pm');
  const [talks, jhas, incidents] = await Promise.all([
    pm.from('cm_toolbox_talks').select('id, held_on, topic, language, presenter_name').eq('job_id', query.jobId).order('held_on', { ascending: false }).limit(200),
    pm.from('cm_jhas').select('id, work_date, task_description, area, status, ppe').eq('job_id', query.jobId).order('work_date', { ascending: false }).limit(200),
    pm.from('cm_incidents').select('id, number, incident_type, occurred_at, person_name, osha_recordable, osha_classification').eq('job_id', query.jobId).order('occurred_at', { ascending: false }).limit(200),
  ]);
  if (talks.error) throw cmError(talks.error);
  return { talks: talks.data ?? [], jhas: jhas.data ?? [], incidents: incidents.error ? [] : incidents.data ?? [] };
});

/** POST /api/commercial/safety — a toolbox talk with its sign-in, a JHA / pre-task plan and its sign-off, an incident report (feeds the OSHA 300 log). */
export const POST = route({
  access: { cap: 'projects.documents', action: 'create' },
  ops: { incident: { cap: 'projects.jobs', action: 'edit' } },
  mask: false,
  body: SafetyAction,
}, async ({ db, body }) => {
  const pm = db.schema('pm');
  switch (body.op) {
    case 'toolbox': {
      const t = cmWrote<{ id: string }>(await pm.from('cm_toolbox_talks').insert({ job_id: body.jobId, held_on: body.heldOn, topic: body.topic, language: body.language, presenter_name: body.presenterName, notes: body.notes }).select('id').single());
      if (body.attendees.length) {
        const a = await pm.from('cm_toolbox_attendance').insert(body.attendees.map((x) => ({ talk_id: t.id, worker_name: x.name, company: x.company, method: 'PAPER' })));
        if (a.error) throw cmError(a.error);
      }
      return t;
    }
    case 'jha':
      return cmWrote<{ id: string }>(await pm.from('cm_jhas').insert({ job_id: body.jobId, work_date: body.workDate, task_description: body.task, area: body.area, steps: body.steps, ppe: body.ppe }).select('id').single());
    case 'sign_jha':
      return { id: await cmRpc<string>(db, 'cm_sign_jha', { p_jha: body.jhaId, p_signoffs: body.signoffs }) };
    case 'incident': {
      if (body.oshaRecordable === true && body.oshaClassification === null) throw new HttpError(422, 'A recordable case needs its OSHA classification.', 'VALIDATION');
      const j = await db.schema('core').from('jobs').select('location_id').eq('id', body.jobId).maybeSingle();
      if (j.error) throw cmError(j.error);
      if (!j.data) throw new HttpError(404, 'That job was not found.', 'NOT_FOUND');
      return cmWrote<{ id: string; number: string | null }>(await pm.from('cm_incidents').insert({
        job_id: body.jobId, location_id: (j.data as { location_id: string }).location_id, incident_type: body.incidentType, occurred_at: body.occurredAt,
        person_name: body.personName, job_title: body.jobTitle, company: body.company, is_employee: body.isEmployee, description: body.description,
        where_occurred: body.whereOccurred, body_part: body.bodyPart, injury_nature: body.injuryNature, osha_recordable: body.oshaRecordable,
        osha_classification: body.oshaClassification, injury_or_illness: body.injuryOrIllness, days_away: body.daysAway, days_restricted: body.daysRestricted,
      }).select('id, number').single());
    }
  }
});
