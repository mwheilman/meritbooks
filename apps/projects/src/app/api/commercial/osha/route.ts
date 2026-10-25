export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { Uuid } from '@/lib/pm/money/schemas';
import { cmRpc } from '@/lib/commercial/server';

/** GET /api/commercial/osha?companyId=&year= — the OSHA 300 log and the 300A summary (rates from hours worked). */
export const GET = route({ access: { cap: 'projects.team', action: 'view' }, mask: false, query: z.object({ companyId: Uuid, year: z.coerce.number().int().min(2000).max(2100) }) }, async ({ db, query }) => {
  const [log, summary] = await Promise.all([
    cmRpc<Array<Record<string, unknown>>>(db, 'cm_osha_300', { p_location: query.companyId, p_year: query.year }),
    cmRpc<Record<string, unknown>>(db, 'cm_osha_300a', { p_location: query.companyId, p_year: query.year }),
  ]);
  return { log, summary };
});
