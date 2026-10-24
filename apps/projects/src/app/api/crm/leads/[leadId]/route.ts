export const dynamic = 'force-dynamic';

import { HttpError, PmQueryError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { can } from '@/lib/access/can';
import { getLead } from '@/lib/crm/queries';
import { loadLeadDetail } from '@/lib/crm/detail';
import { UpdateLeadBody, leadPatch } from '@/lib/crm/schemas';
import { T } from '@/lib/crm/contract';
import { todayIso } from '@/lib/time';

/** One lead with its timeline, follow-ups, contact and site. */
export const GET = route({ access: { cap: 'projects.leads', action: 'view' }, mask: 'estimate' }, async ({ db, params, tenant, access }) => {
  const d = await loadLeadDetail(db, access, tenant.companies, params.leadId!, { nowMs: Date.now(), today: todayIso() });
  if (!d) throw new HttpError(404, 'That lead was not found.', 'NOT_FOUND');
  assertCompany(tenant, d.lead.companyId);
  return d;
});

/**
 * Edit a lead's own fields (crm.leads through RLS: projects.leads:edit at its company). The stage
 * moves through crm.move_lead (…/move), never here. Value needs the contract-value grant.
 */
export const PATCH = route({ access: { cap: 'projects.leads', action: 'edit' }, mask: false, body: UpdateLeadBody }, async ({ db, params, body, tenant, access }) => {
  const lead = await getLead(db, params.leadId!);
  if (!lead) throw new HttpError(404, 'That lead was not found.', 'NOT_FOUND');
  assertCompany(tenant, lead.location_id);
  if (body.valueCents !== undefined && !can(access, 'projects.contract_value', 'view', lead.location_id)) {
    throw new HttpError(403, 'Changing the value needs access to contract amounts.', 'FORBIDDEN');
  }
  const patch = leadPatch(body);
  if (!Object.keys(patch).length) return { ok: true };
  const res = await db.schema(T.leads.schema).from(T.leads.table).update(patch).eq('id', lead.id).select('id');
  if (res.error) throw new PmQueryError('update lead', res.error);
  if (!res.data?.length) throw new HttpError(403, 'You can’t change this lead.', 'FORBIDDEN');
  return { ok: true };
});
