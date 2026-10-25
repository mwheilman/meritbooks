export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { listResponses, resolveResponse } from '@/lib/portal/staff';

/** GET ?jobId — subs' confirm / decline / proposed dates. POST — accept (moves the task start), reject or note. */
const Query = z.object({ jobId: z.string().uuid() });
const Body = z.object({ id: z.string().uuid(), resolution: z.enum(['accepted', 'rejected', 'noted']) });

export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, query: Query }, async ({ db, query }) => ({ responses: await listResponses(db, query.jobId) }));
export const POST = route({ access: { cap: 'projects.jobs', action: 'edit' }, mask: false, body: Body }, async ({ db, body }) => {
  await resolveResponse(db, body.id, body.resolution);
  return { ok: true };
});
