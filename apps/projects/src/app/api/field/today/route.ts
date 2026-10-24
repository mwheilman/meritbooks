export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { loadFieldToday } from '../_lib/today';

/**
 * GET /api/field/today — Merit Workforce's offline bundle: today + the next two days of my
 * assigned work (visits, tasks), the jobs behind it with site location, cost codes, checklists,
 * my week of time, and for supervisors the crew and crew time to approve. No money.
 */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' } }, async ({ db, tenant, access, userId }) => {
  return loadFieldToday(db, tenant, access, userId);
});
