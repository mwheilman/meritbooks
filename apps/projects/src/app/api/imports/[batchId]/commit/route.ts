export const dynamic = 'force-dynamic';
export const maxDuration = 300;

import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { HANDOFF_FOR_ENTITY } from '@/lib/imports/opening';
import { commitImport, loadBatch, saveMapping } from '@/lib/imports/server';

/**
 * POST /api/imports/:batchId/commit — bring the staged rows in (pm.import_commit: match at the
 * door, one subtransaction per row). Idempotent: committing again returns the stored result. The
 * confirmed column mapping is saved for the next file from the same source.
 */
export const POST = route({ access: { cap: 'projects.settings', action: 'configure' } }, async ({ db, params, tenant }) => {
  const b = await loadBatch(db, params.batchId!);
  if (!b) throw new HttpError(404, 'That import was not found.', 'NOT_FOUND');
  assertCompany(tenant, b.location_id);
  const result = await commitImport(db, b.id);
  const signature = typeof b.report?.header_signature === 'string' ? b.report.header_signature : null;
  if (!result.replayed && signature && Object.keys(b.mapping ?? {}).length) {
    await saveMapping(db, b.location_id, b.source_system, b.entity, signature, b.mapping);
  }
  return { result, openingKind: HANDOFF_FOR_ENTITY[b.entity] ?? null };
});
