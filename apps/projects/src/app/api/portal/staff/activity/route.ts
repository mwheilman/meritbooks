export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { portalActivity } from '@/lib/portal/staff';

/** GET ?jobId — what customers, subs and lenders did in the portal on this job (who, what, how verified, when). */
const Query = z.object({ jobId: z.string().uuid() });

export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, query: Query }, async ({ db, query }) => ({ activity: await portalActivity(db, query.jobId) }));
