export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { unwrap } from '@/lib/documents/errors';
import { fileDetail } from '@/lib/documents/store';

/** GET /api/documents/:fileId — the document, its version history (signed links, 15 min), photo metadata and signature requests. */
export const GET = route({ access: { cap: 'projects.documents', action: 'view' }, mask: false }, async ({ db, params }) => fileDetail(db, params.fileId!));

const Patch = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  folderId: z.string().uuid().nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  status: z.enum(['active', 'archived']).optional(),
});

/** PATCH /api/documents/:fileId — rename, move to a folder, describe, tag, archive (documents:edit; RLS decides). */
export const PATCH = route({ access: { cap: 'projects.documents', action: 'edit' }, mask: false, body: Patch }, async ({ db, params, body }) => {
  const r = unwrap<Array<{ id: string }>>(await db.schema('pm').from('doc_files').update({
    ...(body.title !== undefined ? { title: body.title } : {}),
    ...(body.folderId !== undefined ? { folder_id: body.folderId } : {}),
    ...(body.description !== undefined ? { description: body.description } : {}),
    ...(body.tags !== undefined ? { tags: body.tags } : {}),
    ...(body.status !== undefined ? { status: body.status } : {}),
  }).eq('id', params.fileId!).select('id'));
  if (!r?.length) throw new HttpError(403, 'You can’t change this document.', 'FORBIDDEN');
  return { ok: true };
});

/** DELETE /api/documents/:fileId — remove (kept for audit; refused on legal hold, inside retention, or when signed). */
export const DELETE = route({ access: { cap: 'projects.documents', action: 'delete' }, mask: false, body: z.object({ reason: z.string().trim().max(500).optional() }) }, async ({ db, params, body }) => {
  unwrap(await db.schema('pm').rpc('doc_remove', { p_file: params.fileId!, p_reason: body.reason ?? null }));
  return { ok: true };
});
