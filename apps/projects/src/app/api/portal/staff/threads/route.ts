export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { jobThreads, reply } from '@/lib/portal/staff';

/** GET ?jobId — the job's portal threads (customer / per sub / lender). POST — answer one (held until go-live). */
const Query = z.object({ jobId: z.string().uuid() });
const Body = z.object({ jobId: z.string().uuid(), audience: z.enum(['customer', 'vendor', 'lender', 'investor']), partyId: z.string().uuid().nullable(), body: z.string().trim().min(1).max(4000) });

export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, query: Query }, async ({ db, query }) => ({ messages: await jobThreads(db, query.jobId) }));
export const POST = route({ access: { cap: 'projects.jobs', action: 'edit' }, mask: false, body: Body }, async ({ db, body }) => ({ ok: true, ...(await reply(db, body)) }));
