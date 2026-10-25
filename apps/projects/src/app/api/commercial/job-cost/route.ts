export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { IsoDate, Uuid } from '@/lib/pm/money/schemas';
import { cmRpc } from '@/lib/commercial/server';

/** GET /api/commercial/job-cost?jobId=&from=&to= — job cost detail to the source line (CGC-55 drill-down). */
export const GET = route({ access: { cap: 'projects.financials', action: 'view' }, mask: ['cost'], query: z.object({ jobId: Uuid, from: IsoDate.optional(), to: IsoDate.optional() }) }, async ({ db, query }) => {
  return { rows: await cmRpc<Array<Record<string, unknown>>>(db, 'cm_job_cost_detail', { p_job: query.jobId, p_from: query.from ?? null, p_to: query.to ?? null }) };
});
