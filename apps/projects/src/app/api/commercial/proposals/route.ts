export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { ProposalAction } from '@/lib/commercial/schemas';
import { cmRpc } from '@/lib/commercial/server';

/** POST /api/commercial/proposals — send a trade proposal (inclusions, exclusions, alternates), or accept it into a job. */
export const POST = route({
  access: { cap: 'projects.estimates', action: 'edit' },
  ops: { accept: { cap: 'projects.jobs', action: 'create' } },
  mask: ['estimate'],
  body: ProposalAction,
}, async ({ db, body }) => {
  if (body.op === 'send') return { id: await cmRpc<string>(db, 'cm_proposal_send', { p_proposal: body.proposalId, p_envelope: body.envelopeId }) };
  return { jobId: await cmRpc<string>(db, 'cm_proposal_accept', { p_proposal: body.proposalId, p_job_type_key: body.jobTypeKey, p_alternates: body.alternates }) };
});
