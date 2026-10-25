export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { batchRows, loadBatch } from '@/lib/imports/server';

const Query = z.object({
  outcome: z.enum(['PENDING', 'CREATED', 'MATCHED', 'SKIPPED', 'ERROR', 'REFERENCE', 'ROSTER', 'FACT']).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** GET /api/imports/:batchId — the batch, its result and a page of its rows (filter by outcome). */
export const GET = route({ access: { cap: 'projects.settings', action: 'configure' }, query: Query }, async ({ db, params, query, tenant }) => {
  const b = await loadBatch(db, params.batchId!);
  if (!b) throw new HttpError(404, 'That import was not found.', 'NOT_FOUND');
  assertCompany(tenant, b.location_id);
  const page = await batchRows(db, b.id, query);
  return { batch: b, ...page, offset: query.offset, limit: query.limit };
});
