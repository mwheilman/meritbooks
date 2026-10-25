import { z } from 'zod';
import { route } from '@/lib/api';
import { fsCall } from '@/lib/fieldservice/rpc';
import type { EligibleTech } from '@/lib/fieldservice/types';
import { Instant, Uuid } from '@/lib/pm/ops/schemas';

const Query = z.object({ woId: Uuid, start: Instant.optional(), end: Instant.optional() });

/** Who can take this visit (FS-16/104/18): skills and unexpired certifications, zone, BU, blocks, on call. */
export const GET = route({ access: { cap: 'projects.dispatch', action: 'view' }, mask: false, query: Query }, async ({ db, query }) => {
  const techs = await fsCall<EligibleTech[]>(db, 'fs_eligible_techs', { p_wo: query.woId, p_start: query.start ?? null, p_end: query.end ?? null });
  return { techs: [...techs].sort((a, b) => Number(b.eligible) - Number(a.eligible) || Number(b.on_call) - Number(a.on_call) || Number(b.in_zone) - Number(a.in_zone) || a.booked_minutes - b.booked_minutes) };
});
