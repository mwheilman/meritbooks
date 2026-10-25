export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { unwrap } from '@/lib/documents/errors';

/** POST /api/documents/:fileId/versions/:versionId — make an earlier version current again (recorded as a new version). */
export const POST = route({ access: { cap: 'projects.documents', action: 'edit' }, mask: false }, async ({ db, params }) => {
  return { ok: true, ...unwrap<Record<string, unknown>>(await db.schema('pm').rpc('doc_restore_version', { p_version: params.versionId! })) };
});
