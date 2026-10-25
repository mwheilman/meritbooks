export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { EacCreate } from '@/lib/commercial/schemas';
import { cmRpc } from '@/lib/commercial/server';

/** POST /api/commercial/eac — start (or reopen) the month's cost forecast for a job, seeded by cost code (CGC-28). */
export const POST = route({ access: { cap: 'projects.financials', action: 'edit' }, mask: ['job', 'budget', 'wip'], body: EacCreate }, async ({ db, body }) => {
  return { id: await cmRpc<string>(db, 'cm_start_eac', { p_job: body.jobId, p_period_end: body.periodEnd }) };
});
