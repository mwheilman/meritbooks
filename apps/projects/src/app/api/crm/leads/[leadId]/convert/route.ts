export const dynamic = 'force-dynamic';

import { HttpError, PmQueryError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { getLead, listPipelines } from '@/lib/crm/queries';
import { stageById } from '@/lib/crm/stages';
import { ConvertBody } from '@/lib/crm/schemas';
import { convertLeadArgs, parseConvertResult } from '@/lib/crm/contract';

/**
 * Lead → estimate or job (crm.convert_lead, BP-52/53): the customer comes through the matcher if
 * the lead has none yet; the lead stays linked to what it became.
 */
export const POST = route(
  {
    access: { cap: 'projects.leads', action: 'edit' },
    ops: { estimate: { cap: 'projects.estimates', action: 'create' }, job: { cap: 'projects.jobs', action: 'create' } },
    mask: false,
    body: ConvertBody,
  },
  async ({ db, params, body, tenant }) => {
    const lead = await getLead(db, params.leadId!);
    if (!lead) throw new HttpError(404, 'That lead was not found.', 'NOT_FOUND');
    assertCompany(tenant, lead.location_id);
    if (lead.converted_job_id || lead.converted_estimate_id) throw new HttpError(409, 'This lead already became a job.', 'ALREADY_CONVERTED');
    const stage = stageById((await listPipelines(db, [lead.location_id])).find((p) => p.id === lead.pipeline_id) ?? null, lead.stage_id);
    if (stage?.kind === 'lost') throw new HttpError(422, 'Reopen the lead before turning it into work.', 'LEAD_LOST');
    const res = await db.schema('crm').rpc('convert_lead', convertLeadArgs(lead.id, body.op, body.jobTypeKey));
    if (res.error) throw new PmQueryError('convert lead', res.error);
    const ids = parseConvertResult(res.data);
    return { ...ids, href: ids.jobId ? `/jobs/${ids.jobId}${body.op === 'estimate' ? '?tab=estimates' : ''}` : `/leads/${lead.id}` };
  },
);
