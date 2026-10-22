export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { dwrite } from '@/lib/pm/dealer/rpc';
import { Uuid } from '@/lib/pm/dealer/schemas';

const Body = z.object({
  companyId: Uuid,
  code: z.string().trim().min(1, 'Give it a short code').max(24).transform((s) => s.toUpperCase()),
  name: z.string().trim().min(1, 'Name it').max(80),
  kind: z.enum(['WAREHOUSE', 'SHOP', 'STAGING', 'RECEIVER']).default('WAREHOUSE'),
});

/** A lot, parts room or shop as a stock location (pm.stock_locations, 1104), for units and parts. */
export const POST = route({ access: { cap: 'projects.store', action: 'edit' }, mask: false, body: Body }, async ({ db, body, tenant }) => {
  assertCompany(tenant, body.companyId);
  const r = await dwrite<Array<{ id: string }>>(db.schema('pm').from('stock_locations').insert({ location_id: body.companyId, code: body.code, name: body.name, kind: body.kind }).select('id'), 'add stock location');
  if (!r[0]) throw new HttpError(500, 'The stock location was not saved. Try again.', 'CREATE_FAILED');
  return { stockLocationId: r[0].id };
});
