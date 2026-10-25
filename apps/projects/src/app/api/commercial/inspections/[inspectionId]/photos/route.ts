export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { Uuid } from '@/lib/pm/money/schemas';
import { cmError, cmWrote } from '@/lib/commercial/server';

/**
 * POST /api/commercial/inspections/:id/photos — attach an uploaded photo (a /api/documents file
 * on the same job) to a checklist item; items marked "needs a photo" cannot complete without one.
 */
export const POST = route({ access: { cap: 'projects.jobs', action: 'edit' }, mask: false, body: z.object({ itemId: Uuid, fileId: Uuid }) }, async ({ db, body, params }) => {
  const pm = db.schema('pm');
  const it = await pm.from('cm_inspection_items').select('id, job_id, photo_ids').eq('id', body.itemId).eq('inspection_id', params.inspectionId!).maybeSingle();
  if (it.error) throw cmError(it.error);
  const row = it.data as { id: string; job_id: string | null; photo_ids: string[] } | null;
  if (!row) throw new HttpError(404, 'That checklist item was not found.', 'NOT_FOUND');
  const f = await pm.from('doc_files').select('id, job_id').eq('id', body.fileId).maybeSingle();
  if (f.error) throw cmError(f.error);
  const file = f.data as { id: string; job_id: string | null } | null;
  if (!file || (row.job_id && file.job_id !== row.job_id)) throw new HttpError(422, 'Upload the photo to this job first.', 'VALIDATION');
  const ids = [...new Set([...(row.photo_ids ?? []), body.fileId])].slice(0, 20);
  return cmWrote<{ id: string; photo_ids: string[] }>(await pm.from('cm_inspection_items').update({ photo_ids: ids }).eq('id', row.id).select('id, photo_ids').single());
});
