export const dynamic = 'force-dynamic';

import { HttpError, PmQueryError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { getLead } from '@/lib/crm/queries';
import { FollowupBody } from '@/lib/crm/schemas';
import { T } from '@/lib/crm/contract';

/** Add a follow-up to a lead (crm.followups through RLS: projects.leads:edit at its company). */
export const POST = route({ access: { cap: 'projects.leads', action: 'edit' }, mask: false, body: FollowupBody }, async ({ db, params, body, tenant, access }) => {
  const lead = await getLead(db, params.leadId!);
  if (!lead) throw new HttpError(404, 'That lead was not found.', 'NOT_FOUND');
  assertCompany(tenant, lead.location_id);
  const res = await db.schema(T.followups.schema).from(T.followups.table)
    .insert({ lead_id: lead.id, due_on: body.dueOn, kind: body.kind, assigned_membership_id: body.assignedMembershipId ?? lead.owner_membership_id ?? access.membershipId })
    .select('id').maybeSingle();
  if (res.error) throw new PmQueryError('add follow-up', res.error);
  return { ok: true, id: (res.data as { id: string } | null)?.id ?? null };
});
