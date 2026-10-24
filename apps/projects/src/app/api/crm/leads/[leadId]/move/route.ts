export const dynamic = 'force-dynamic';

import { HttpError, PmQueryError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { getLead, listPipelines } from '@/lib/crm/queries';
import { checkMove, reasonProblem, stageById } from '@/lib/crm/stages';
import { MoveLeadBody } from '@/lib/crm/schemas';
import { moveLeadArgs } from '@/lib/crm/contract';

/** Move a lead to another stage (crm.move_lead). Lost and reopen need a reason (BP-51). */
export const POST = route({ access: { cap: 'projects.leads', action: 'edit' }, mask: false, body: MoveLeadBody }, async ({ db, params, body, tenant }) => {
  const lead = await getLead(db, params.leadId!);
  if (!lead) throw new HttpError(404, 'That lead was not found.', 'NOT_FOUND');
  assertCompany(tenant, lead.location_id);
  const pipe = (await listPipelines(db, [lead.location_id])).find((p) => p.id === lead.pipeline_id) ?? null;
  const to = stageById(pipe, body.stageId);
  if (!to) throw new HttpError(422, 'That stage is not in this lead’s pipeline.', 'VALIDATION');
  const check = checkMove(lead, stageById(pipe, lead.stage_id), to);
  if (!check.ok) throw new HttpError(422, check.message, 'MOVE_NOT_ALLOWED');
  const problem = reasonProblem(check.reason, body.reason);
  if (problem) throw new HttpError(422, problem, 'REASON_REQUIRED');
  const res = await db.schema('crm').rpc('move_lead', moveLeadArgs(lead.id, to.id, body.reason));
  if (res.error) throw new PmQueryError('move lead', res.error);
  return { ok: true, stage: { id: to.id, name: to.name, kind: to.kind } };
});
