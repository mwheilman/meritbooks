export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { xcall } from '@/lib/dealer/rpc';
import { Uuid } from '@/lib/dealer/schemas';

/** Backlog in shop hours against each work center's capacity, by week (booked + weighted quoted). */
export const GET = route({ access: { cap: 'projects.production', action: 'view' }, query: z.object({ company: Uuid, weeks: z.coerce.number().int().min(1).max(52).default(12) }) }, async ({ db, query, tenant }) => {
  assertCompany(tenant, query.company);
  return xcall(db, 'mfg_backlog', { p_location: query.company, p_weeks: query.weeks });
});
