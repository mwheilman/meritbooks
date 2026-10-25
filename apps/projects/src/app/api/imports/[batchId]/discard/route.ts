export const dynamic = 'force-dynamic';

import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { discardImport, loadBatch } from '@/lib/imports/server';

/** POST /api/imports/:batchId/discard — undo an import that was not brought in yet. */
export const POST = route({ access: { cap: 'projects.settings', action: 'configure' }, mask: false }, async ({ db, params, tenant }) => {
  const b = await loadBatch(db, params.batchId!);
  if (!b) throw new HttpError(404, 'That import was not found.', 'NOT_FOUND');
  assertCompany(tenant, b.location_id);
  return discardImport(db, b.id);
});
