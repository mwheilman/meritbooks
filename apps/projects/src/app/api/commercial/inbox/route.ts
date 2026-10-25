export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { Uuid } from '@/lib/pm/money/schemas';
import { loadInbox } from '@/lib/commercial/server';

/**
 * GET /api/commercial/inbox?companyId= — ball in court across the commercial records: RFIs,
 * submittal reviews, sub pay apps at the caller's step, PCOs with the owner, T&M to sign,
 * forecasts to approve, meeting items, observations, payment holds. Each row is only what the
 * caller can see; "mine" marks the ones waiting on them.
 */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, query: z.object({ companyId: Uuid.optional() }) }, async ({ db, query }) => {
  return { items: await loadInbox(db, query.companyId ?? null) };
});
