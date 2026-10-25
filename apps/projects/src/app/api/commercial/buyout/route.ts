export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { Uuid } from '@/lib/pm/money/schemas';
import { cmError, cmRpc } from '@/lib/commercial/server';

/** GET /api/commercial/buyout?jobId= — the buyout log: budget vs bought by package, savings or loss, what is not bought yet (CGC-30). */
export const GET = route({ access: { cap: 'projects.financials', action: 'view' }, mask: ['budget', 'commitment'], query: z.object({ jobId: Uuid }) }, async ({ db, query }) => {
  const res = await db.schema('pm').from('cm_v_buyout').select('*').eq('job_id', query.jobId);
  if (res.error) throw cmError(res.error);
  return { packages: res.data ?? [] };
});

/** POST /api/commercial/buyout — seed the buyout packages from the budget's subcontract and material cost codes. */
export const POST = route({ access: { cap: 'projects.commitments', action: 'edit' }, mask: false, body: z.object({ jobId: Uuid }) }, async ({ db, body }) => {
  return { seeded: await cmRpc<number>(db, 'cm_seed_buyout', { p_job: body.jobId }) };
});
