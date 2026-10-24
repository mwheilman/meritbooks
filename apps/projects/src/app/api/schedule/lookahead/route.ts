export const dynamic = 'force-dynamic';

/** The look-ahead: pm.schedule_lookahead(p_from, p_days) with constraint reasons. projects.jobs:view. */
import { z } from 'zod';
import { route } from '@/lib/api';
import { loadLookahead } from '@/lib/pm/schedule/server';

const Query = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-16'),
  days: z.coerce.number().int().min(1).max(84).default(21),
});

export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, query: Query, mask: false }, async ({ db, query }) => {
  const rows = await loadLookahead(db, query.from, query.days);
  return { rows: rows ?? [], engine: rows !== null };
});
