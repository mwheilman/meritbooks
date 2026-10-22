export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { dcall, downs } from '@/lib/pm/dealer/rpc';
import { Text, Uuid, attrs } from '@/lib/pm/dealer/schemas';

const Body = z.object({
  to: z.enum(['ORDERED', 'RECEIVED', 'NOTIFIED', 'PICKED_UP', 'CANCELLED']),
  vendorId: Uuid.nullish(),
  stockLocationId: Uuid.nullish(),
  reason: Text(300).nullish(),
});

/** REQUESTED → ORDERED → RECEIVED (into stock) → NOTIFIED → PICKED_UP; open → CANCELLED (pm.advance_special_order). */
export const POST = route({ body: Body }, async ({ db, params, body, tenant }) => {
  const so = await downs<{ id: string; location_id: string }>(db, 'parts_special_orders', 'id, location_id', params.soId!, 'That special order was not found.');
  assertCompany(tenant, so.location_id);
  await dcall(db, 'advance_special_order', { p_so: so.id, p_to: body.to, p_attrs: attrs({ vendor_id: body.vendorId, stock_location_id: body.stockLocationId, reason: body.reason }) });
  return { ok: true };
});
