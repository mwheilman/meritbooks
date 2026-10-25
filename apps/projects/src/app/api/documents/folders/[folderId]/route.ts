export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { unwrap } from '@/lib/documents/errors';

/** PATCH /api/documents/folders/:folderId — rename / reorder. */
export const PATCH = route({
  access: { cap: 'projects.documents', action: 'edit' }, mask: false,
  body: z.object({ name: z.string().trim().min(1).max(80).optional(), sort: z.number().int().min(0).max(10000).optional() }),
}, async ({ db, params, body }) => {
  const r = unwrap<Array<{ id: string }>>(await db.schema('pm').from('doc_folders').update(body).eq('id', params.folderId!).select('id'));
  if (!r?.length) throw new HttpError(403, 'You can’t change this folder.', 'FORBIDDEN');
  return { ok: true };
});

/** DELETE /api/documents/folders/:folderId — remove an empty folder (its documents would move to "no folder"). */
export const DELETE = route({ access: { cap: 'projects.documents', action: 'delete' }, mask: false }, async ({ db, params }) => {
  const used = await db.schema('pm').from('doc_files').select('id', { count: 'exact', head: true }).eq('folder_id', params.folderId!).neq('status', 'deleted');
  if ((used.count ?? 0) > 0) throw new HttpError(422, 'Move the documents out of this folder first.', 'FOLDER_NOT_EMPTY');
  const r = unwrap<Array<{ id: string }>>(await db.schema('pm').from('doc_folders').delete().eq('id', params.folderId!).select('id'));
  if (!r?.length) throw new HttpError(403, 'You can’t remove this folder.', 'FORBIDDEN');
  return { ok: true };
});
