export const dynamic = 'force-dynamic';

import { PmQueryError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { completeFollowupArgs } from '@/lib/crm/contract';

/** Mark a follow-up done (crm.complete_followup; the function checks the lead's company grant). */
export const POST = route({ access: { cap: 'projects.leads', action: 'edit' }, mask: false }, async ({ db, params }) => {
  const res = await db.schema('crm').rpc('complete_followup', completeFollowupArgs(params.followupId!));
  if (res.error) throw new PmQueryError('complete follow-up', res.error);
  return { ok: true };
});
