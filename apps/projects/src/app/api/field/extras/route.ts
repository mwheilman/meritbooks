export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { loadExtras } from '../_lib/phone-reads';

const Ids = z.string().max(4000).optional().transform((s) => [...new Set((s ?? '').split(',').map((x) => x.trim()).filter((x) => /^[0-9a-f-]{36}$/i.test(x)))].slice(0, 60));

/**
 * GET /api/field/extras?wo=<work order ids>&jobs=<job ids> — what Merit Workforce adds to today's
 * cached work (Wave C): per visit the kind, the site's gate code / pets / access notes, membership
 * and whether options are ready to present; per job the occupied-home rules a lead carpenter needs
 * (lockbox, alarm, pets, hours, parking, off-limits rooms) and the count of current drawing sheets;
 * and which phone features this person has (station mode, RO clock, installer pay, e-sign). No money.
 */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, query: z.object({ wo: Ids, jobs: Ids }) }, async ({ db, tenant, access, userId, query }) =>
  loadExtras(db, tenant, access, userId, query.wo, query.jobs));
