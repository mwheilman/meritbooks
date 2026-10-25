export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { IsoDate, Uuid } from '@/lib/pm/money/schemas';
import { cmRpc } from '@/lib/commercial/server';

/** GET /api/commercial/foreman-plan?jobId=&date= — the foreman's day: crew, hours budget left by cost code, what to install, open items. */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, query: z.object({ jobId: Uuid, date: IsoDate.optional() }) }, async ({ db, query }) => {
  return cmRpc<Record<string, unknown>>(db, 'cm_foreman_plan', { p_job: query.jobId, p_date: query.date ?? null });
});
