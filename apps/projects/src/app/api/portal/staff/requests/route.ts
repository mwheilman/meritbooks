export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { listRequests, updateRequest } from '@/lib/portal/staff';

/** GET — warranty / service requests from the portal. POST — acknowledge / schedule / close / link to a punch item. */
const Query = z.object({ companyId: z.string().uuid().optional(), status: z.enum(['new', 'acknowledged', 'scheduled', 'closed', 'converted']).optional() });
const Body = z.object({ id: z.string().uuid(), status: z.enum(['new', 'acknowledged', 'scheduled', 'closed', 'converted']), note: z.string().trim().max(2000).nullish(), punchItemId: z.string().uuid().nullish() });

export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, query: Query }, async ({ db, query }) => ({ requests: await listRequests(db, query) }));
export const POST = route({ access: { cap: 'projects.jobs', action: 'edit' }, mask: false, body: Body }, async ({ db, body }) => {
  await updateRequest(db, body);
  return { ok: true };
});
