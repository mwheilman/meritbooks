export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { xcall } from '@/lib/dealer/rpc';
import { Uuid } from '@/lib/dealer/schemas';

/** Every development project the caller reaches with job financials: stage, in balance, contingency left, dates due, capital needs by month. */
export const GET = route({ access: { cap: 'projects.financials', action: 'view' }, mask: ['job', 'budget', 'billing'], query: z.object({ company: Uuid.optional() }) }, async ({ db, query, tenant }) => {
  if (query.company) assertCompany(tenant, query.company);
  return xcall(db, 'dev_overview', { p_location: query.company ?? null });
});
