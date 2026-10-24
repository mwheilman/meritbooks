export const dynamic = 'force-dynamic';

/**
 * All jobs' schedules (the global Schedule page): pm.v_schedule_jobs, one summary row per job
 * the caller can see (RLS), optionally narrowed to some jobs. projects.jobs:view.
 */
import { z } from 'zod';
import { route } from '@/lib/api';
import { loadScheduleJobs } from '@/lib/pm/schedule/server';

const Query = z.object({ jobIds: z.string().max(40_000).optional() });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, query: Query, mask: false }, async ({ db, query }) => {
  const ids = (query.jobIds ?? '').split(',').filter((x) => UUID.test(x));
  if (!ids.length) return { jobs: [] };
  const jobs = await loadScheduleJobs(db, ids);
  return { jobs: jobs ?? [], engine: jobs !== null };
});
