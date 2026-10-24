export const dynamic = 'force-dynamic';

import { HttpError, PmQueryError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { getLead } from '@/lib/crm/queries';
import { ActivityBody } from '@/lib/crm/schemas';
import { T, logActivityArgs } from '@/lib/crm/contract';

/** Log a call, text, email, meeting, visit or note on a lead (crm.log_activity), and its next step. */
export const POST = route({ access: { cap: 'projects.leads', action: 'edit' }, mask: false, body: ActivityBody }, async ({ db, params, body, tenant }) => {
  const lead = await getLead(db, params.leadId!);
  if (!lead) throw new HttpError(404, 'That lead was not found.', 'NOT_FOUND');
  assertCompany(tenant, lead.location_id);
  const res = await db.schema('crm').rpc('log_activity', logActivityArgs({
    kind: body.kind, leadId: lead.id, customerId: lead.customer_id, contactId: lead.contact_id, jobId: lead.converted_job_id,
    direction: body.direction, subject: body.subject, body: body.body, outcome: body.outcome, occurredAt: body.occurredAt,
  }));
  if (res.error) throw new PmQueryError('log activity', res.error);
  if (body.nextStep || body.nextStepOn) {
    const u = await db.schema(T.leads.schema).from(T.leads.table).update({ next_step: body.nextStep ?? lead.next_step, next_step_on: body.nextStepOn ?? lead.next_step_on }).eq('id', lead.id);
    if (u.error) throw new PmQueryError('next step', u.error);
  }
  return { ok: true, id: typeof res.data === 'string' ? res.data : null };
});
