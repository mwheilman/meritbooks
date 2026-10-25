import { z } from 'zod';
import { route } from '@/lib/api';
import { loadCapacityGrid } from '@/lib/fieldservice/queries';
import { Day, Uuid } from '@/lib/pm/ops/schemas';

const Query = z.object({ companyId: Uuid, from: Day, days: z.coerce.number().int().min(1).max(31).default(7) });

/** Capacity grid (FS-15): day × business unit × arrival window, booked vs limit (REQUEST holds count). */
export const GET = route({ access: { cap: 'projects.dispatch', action: 'view' }, mask: false, query: Query }, async ({ db, query }) => {
  return { cells: await loadCapacityGrid(db, query.companyId, query.from, query.days) };
});
