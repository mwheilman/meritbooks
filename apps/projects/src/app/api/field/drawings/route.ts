export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { loadDrawings } from '../_lib/phone-reads';

const Ids = z.string().max(2000).transform((s) => [...new Set(s.split(',').map((x) => x.trim()).filter((x) => /^[0-9a-f-]{36}$/i.test(x)))].slice(0, 30));

/**
 * GET /api/field/drawings?jobIds=a,b — the CURRENT drawing set of the jobs on my phone: one row per
 * sheet with its current revision and a one-hour signed link. The phone downloads each new
 * revision into its own storage (keyed by revision id) so the set opens with no signal, and drops
 * superseded revisions. RLS limits it to my jobs; no money.
 */
export const GET = route({ access: { cap: 'projects.documents', action: 'view' }, query: z.object({ jobIds: Ids }) }, async ({ db, query }) => loadDrawings(db, query.jobIds));
