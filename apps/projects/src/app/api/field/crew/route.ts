export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { loadFieldToday } from '../_lib/today';

/** GET /api/field/crew — my crew and the submitted crew time waiting for my approval (hours only). */
export const GET = route({ access: { cap: 'projects.time', action: 'approve' } }, async ({ db, tenant, access, userId }) => {
  const t = await loadFieldToday(db, tenant, access, userId);
  return { crew: t.crew, crewTime: t.crewTime, jobs: t.jobs.map((j) => ({ id: j.id, number: j.number, name: j.name })), serverTime: t.serverTime };
});
