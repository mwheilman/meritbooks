export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { Uuid } from '@/lib/pm/money/schemas';
import { DocControlAction } from '@/lib/commercial/schemas';
import { cmError, cmWrote } from '@/lib/commercial/server';

/** GET /api/commercial/correspondence?jobId= — transmittals and the job's letters and notices (numbered per type, CGC-67). */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, query: z.object({ jobId: Uuid }) }, async ({ db, query }) => {
  const pm = db.schema('pm');
  const [t, c] = await Promise.all([
    pm.from('cm_transmittals').select('id, number, subject, to_name, to_company, purpose, items, status, sent_at, acknowledged_at').eq('job_id', query.jobId).order('created_at', { ascending: false }).limit(300),
    pm.from('cm_correspondence').select('id, corr_type, number, direction, subject, from_name, to_name, to_company, sent_on, response_required_by, responded_on, status, change_event_id').eq('job_id', query.jobId).order('created_at', { ascending: false }).limit(300),
  ]);
  if (t.error) throw cmError(t.error);
  if (c.error) throw cmError(c.error);
  return { transmittals: t.data ?? [], correspondence: c.data ?? [] };
});

/** POST /api/commercial/correspondence — a transmittal (what was sent, to whom, why) or a letter / notice (delay, claim, backcharge) with its response date. */
export const POST = route({ access: { cap: 'projects.documents', action: 'create' }, mask: false, body: DocControlAction }, async ({ db, body }) => {
  const pm = db.schema('pm');
  if (body.op === 'transmittal') {
    return cmWrote<{ id: string; number: string }>(await pm.from('cm_transmittals').insert({
      job_id: body.jobId, subject: body.subject, to_name: body.toName, to_company: body.toCompany, to_email: body.toEmail, purpose: body.purpose, items: body.items, notes: body.notes,
    }).select('id, number').single());
  }
  return cmWrote<{ id: string; number: string }>(await pm.from('cm_correspondence').insert({
    job_id: body.jobId, corr_type: body.corrType, direction: body.direction, subject: body.subject, body: body.body, from_name: body.fromName, to_name: body.toName,
    to_company: body.toCompany, sent_on: body.sentOn, response_required_by: body.responseRequiredBy, change_event_id: body.changeEventId,
  }).select('id, number').single());
});
