export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { dcall } from '@/lib/pm/dealer/rpc';
import { Uuid } from '@/lib/pm/dealer/schemas';

const Body = z.object({ stockLocationId: Uuid, partIds: z.array(Uuid).max(5000).nullish() });

/** Start a physical count at a stock location (pm.start_parts_count snapshots on-hand per part). */
export const POST = route({ access: { cap: 'projects.store', action: 'create' }, mask: 'part', body: Body }, async ({ db, body, tenant }) => {
  const sl = await db.schema('pm').from('stock_locations').select('location_id').eq('id', body.stockLocationId).maybeSingle();
  const loc = (sl.data as { location_id: string } | null)?.location_id;
  if (!loc) throw new HttpError(404, 'That stock location was not found.', 'NOT_FOUND');
  assertCompany(tenant, loc);
  const id = await dcall<string>(db, 'start_parts_count', { p_stock_location: body.stockLocationId, p_parts: body.partIds?.length ? body.partIds : null });
  return { countId: id };
});
