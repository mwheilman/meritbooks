export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { listLeads, listPipelines } from '@/lib/crm/queries';
import { buildLeadViews } from '@/lib/crm/build';
import { createLead } from '@/lib/crm/create';
import { NewLeadBody } from '@/lib/crm/schemas';
import { todayIso } from '@/lib/time';

/** Leads in the caller's companies (crm.leads, class C), as the board and list draw them. */
export const GET = route(
  {
    access: { cap: 'projects.leads', action: 'view' },
    mask: 'estimate',
    query: z.object({ companyId: z.string().uuid().optional(), pipelineId: z.string().uuid().optional() }),
  },
  async ({ db, query, tenant, access }) => {
    if (query.companyId) assertCompany(tenant, query.companyId);
    const companyIds = query.companyId ? [query.companyId] : tenant.companies.map((c) => c.id);
    const [pipes, leads] = await Promise.all([listPipelines(db, companyIds), listLeads(db, { companyIds, pipelineId: query.pipelineId ?? null })]);
    const views = await buildLeadViews(db, leads, pipes, access, tenant.companies, { nowMs: Date.now(), today: todayIso() });
    return { leads: views };
  },
);

/**
 * New lead (crm.create_lead). The person is matched at the door first: an exact match answers
 * 409 MATCH_FOUND with the candidates unless the form chose one (`customer.match.useId`) or typed
 * why this is a different customer (`customer.match.newReason`).
 */
export const POST = route({ access: { cap: 'projects.leads', action: 'create' }, mask: false, body: NewLeadBody }, async ({ db, body, tenant, access }) => {
  assertCompany(tenant, body.companyId);
  return createLead(db, access, body, tenant.companies.find((c) => c.id === body.companyId)?.name ?? null);
});
