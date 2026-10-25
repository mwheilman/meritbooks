export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { field, readUpload } from '@/lib/documents/http';
import { addVersion, MAX_FILE_BYTES, storeObject } from '@/lib/documents/store';
import { unwrap } from '@/lib/documents/errors';
import type { DocKind } from '@/lib/documents/types';

/**
 * POST /api/documents/:fileId/versions (multipart: file, label, note) — upload a new version; the
 * previous one is kept as superseded. Needs documents:edit, or create on your own document.
 */
export const POST = route({ access: { cap: 'projects.documents', action: 'create' }, mask: false }, async ({ req, db, params, tenant, userId }) => {
  const f = unwrap<{ kind: DocKind } | null>(await db.schema('pm').from('doc_files').select('kind').eq('id', params.fileId!).maybeSingle());
  const up = await readUpload(req, { maxBytes: MAX_FILE_BYTES });
  const obj = await storeObject(db, { orgId: tenant.orgId, userId }, { area: 'docs', fileName: up.file.name, mimeType: up.mimeType, bytes: up.bytes, kind: f?.kind ?? 'file' });
  const v = await addVersion(db, params.fileId!, obj, { label: field(up.form, 'label', 40), note: field(up.form, 'note', 1000) });
  return { ok: true, ...v };
});
