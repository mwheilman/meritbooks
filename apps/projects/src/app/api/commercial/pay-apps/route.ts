export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { PayAppCreate } from '@/lib/commercial/schemas';
import { cmRpc } from '@/lib/commercial/server';

/**
 * POST /api/commercial/pay-apps — draft the next owner pay application from the SOV (approved
 * COs synced in first, step-downs and stored materials applied, CGC-41..44), or sync approved
 * change orders onto the schedule of values without drafting.
 */
export const POST = route({ access: { cap: 'projects.billing', action: 'create' }, ops: { sync_sov: { cap: 'projects.billing', action: 'edit' } }, mask: ['billing'], body: PayAppCreate }, async ({ db, body }) => {
  if (body.op === 'sync_sov') return { added: await cmRpc<number>(db, 'cm_sync_cos_to_sov', { p_job: body.jobId }, 'billing request') };
  return { id: await cmRpc<string>(db, 'cm_draft_pay_app', { p_job: body.jobId, p_period_end: body.periodEnd, p_lines: body.lines, p_sync_cos: body.syncCos }, 'billing request') };
});
