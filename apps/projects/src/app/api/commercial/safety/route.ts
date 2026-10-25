export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { Uuid } from '@/lib/pm/money/schemas';
import { SafetyAction } from '@/lib/commercial/schemas';
import { cmError, cmRpc, cmWrote } from '@/lib/commercial/server';
import { can } from '@/lib/access/can';
import { redactPrivacyCase, type IncidentPrivate } from '@/lib/commercial/screen-logic';

const INCIDENT_COLS = 'id, job_id, location_id, number, incident_type, occurred_at, reported_at, person_name, job_title, company, is_employee, description, where_occurred, body_part, injury_nature, object_substance, witnesses, root_cause, corrective_actions, osha_recordable, osha_classification, injury_or_illness, days_away, days_restricted, privacy_case, case_number, wc_claim_ref, status';

/**
 * GET /api/commercial/safety?jobId= — toolbox talks, JHAs and (for those who may see them) incidents on a job.
 * OSHA privacy cases come back without the name or injury detail unless the caller holds projects.team:edit
 * at the job's company (there is no separate safety-manager capability).
 */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, query: z.object({ jobId: Uuid }) }, async ({ db, query, access }) => {
  const pm = db.schema('pm');
  const [talks, att, jhas, incidents] = await Promise.all([
    pm.from('cm_toolbox_talks').select('id, job_id, held_on, topic, language, presenter_name, notes').eq('job_id', query.jobId).order('held_on', { ascending: false }).limit(200),
    pm.from('cm_toolbox_attendance').select('talk_id').eq('job_id', query.jobId).limit(5000),
    pm.from('cm_jhas').select('id, job_id, work_date, task_description, area, steps, ppe, permits, status, signoffs').eq('job_id', query.jobId).order('work_date', { ascending: false }).limit(200),
    pm.from('v_cm_incidents_masked').select(INCIDENT_COLS).eq('job_id', query.jobId).order('occurred_at', { ascending: false }).limit(200),
  ]);
  if (talks.error) throw cmError(talks.error);
  const n = new Map<string, number>();
  for (const a of (att.data ?? []) as Array<{ talk_id: string }>) n.set(a.talk_id, (n.get(a.talk_id) ?? 0) + 1);
  return {
    talks: ((talks.data ?? []) as Array<{ id: string }>).map((t) => ({ ...t, attendees: n.get(t.id) ?? 0 })),
    jhas: jhas.data ?? [],
    // privacy cases: the masked view nulls name and injury detail at the database unless the caller holds
    // projects.team:edit at the incident's company; the same rule again here (defense in depth, L5)
    incidents: incidents.error ? [] : ((incidents.data ?? []) as Array<IncidentPrivate & { location_id: string | null }>).map((i) => redactPrivacyCase(i, can(access, 'projects.team', 'edit', i.location_id))),
    incidentsVisible: !incidents.error,
  };
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
