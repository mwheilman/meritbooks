export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { PcoCreate } from '@/lib/commercial/schemas';
import { cmRpc } from '@/lib/commercial/server';

/**
 * POST /api/commercial/pcos — build a PCO from change events (markup rules applied, CGC-34),
 * or roll PCOs into a COR (three-tier, CGC-34).
 */
export const POST = route({ access: { cap: 'projects.change_orders', action: 'edit' }, ops: { build: { cap: 'projects.contract_value', action: 'view' } }, mask: ['change_order', 'change_event'], body: PcoCreate }, async ({ db, body }) => {
  if (body.op === 'build') return { id: await cmRpc<string>(db, 'cm_build_pco', { p_job: body.jobId, p_change_events: body.changeEventIds, p_title: body.title, p_tier: null }) };
  return { id: await cmRpc<string>(db, 'cm_roll_to_cor', { p_pcos: body.pcoIds, p_title: body.title }) };
});
