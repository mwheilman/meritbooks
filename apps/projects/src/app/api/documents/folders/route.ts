export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { unwrap } from '@/lib/documents/errors';
import { ensureFolders, folderCounts, listFolders } from '@/lib/documents/store';
import { can } from '@/lib/access/can';

/** GET /api/documents/folders?jobId= — the job's folders (created from the pack template on first open) with counts. */
export const GET = route({ access: { cap: 'projects.documents', action: 'view' }, mask: false, query: z.object({ jobId: z.string().uuid() }) }, async ({ db, query, access }) => {
  let folders = await listFolders(db, query.jobId);
  if (folders.length === 0 && can(access, 'projects.documents', 'create')) {
    await ensureFolders(db, query.jobId).catch(() => 0);
    folders = await listFolders(db, query.jobId);
  }
  return { folders, counts: await folderCounts(db, query.jobId) };
});

/** POST /api/documents/folders — add a folder to a job. */
export const POST = route({
  access: { cap: 'projects.documents', action: 'create' }, mask: false,
  body: z.object({ jobId: z.string().uuid(), name: z.string().trim().min(1).max(80), parentId: z.string().uuid().nullable().optional() }),
}, async ({ db, body }) => {
  const r = unwrap<{ id: string }>(await db.schema('pm').from('doc_folders').insert({ job_id: body.jobId, name: body.name, parent_id: body.parentId ?? null, sort: 900 }).select('id').single());
  return { ok: true, id: r.id };
});
