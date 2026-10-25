export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { listProposals } from '@/lib/residential/queries';
import { resRpc } from '@/lib/residential/rpc';
import { NewProposalZ, attrsToDb } from '@/lib/residential/schemas';

/** Proposals at the companies in view (sell side only; cost stays on the proposal page). */
export const GET = route({ access: { cap: 'projects.estimates', action: 'view' }, mask: 'estimate' }, async ({ db, tenant }) => {
  const ids = tenant.activeCompanyId ? [tenant.activeCompanyId] : tenant.companies.map((c) => c.id);
  return { proposals: await listProposals(db, ids) };
});

/**
 * Start a proposal: from a crm lead (crm.convert_lead makes the presale job and the shared
 * customer through the matcher) or on an existing job (design → build on the same job).
 */
export const POST = route({ access: { cap: 'projects.estimates', action: 'create' }, mask: false, body: NewProposalZ }, async ({ db, body }) => {
  const id = await resRpc<string>(db, 'res_create_proposal', {
    p_location: body.companyId ?? null, p_lead: body.leadId ?? null, p_job: body.jobId ?? null, p_title: body.title ?? null,
    p_job_type_key: body.jobTypeKey ?? null, p_attrs: attrsToDb(body.attrs),
  });
  return { proposalId: id };
});
