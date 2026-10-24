export const dynamic = 'force-dynamic';

/** The crew board: pm.resource_load(p_from, p_to), crew / vendor × day hours. projects.jobs:view. */
import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { loadResourceLoad } from '@/lib/pm/schedule/server';

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-16');
const Query = z.object({ from: Day, to: Day });

export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, query: Query, mask: false }, async ({ db, query }) => {
  if (query.to < query.from) throw new HttpError(422, 'The end date is before the start date.', 'VALIDATION');
  const span = (Date.parse(query.to) - Date.parse(query.from)) / 86_400_000;
  if (span > 92) throw new HttpError(422, 'Show at most three months at a time.', 'VALIDATION');
  const cells = await loadResourceLoad(db, query.from, query.to);
  return { cells: cells ?? [], engine: cells !== null };
});
