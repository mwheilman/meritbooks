export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { unwrap } from '@/lib/documents/errors';

const Body = z.object({
  sheetNumber: z.string().trim().min(1).max(40).optional(),
  title: z.string().trim().max(200).nullable().optional(),
  discipline: z.string().trim().max(40).nullable().optional(),
  revisionLabel: z.string().trim().max(20).nullable().optional(),
});

/** PATCH /api/documents/drawings/revisions/:revisionId — correct a page's sheet number, title, discipline or revision. */
export const PATCH = route({ access: { cap: 'projects.documents', action: 'edit' }, mask: false, body: Body }, async ({ db, params, body }) => {
  const attrs: Record<string, unknown> = {};
  if (body.sheetNumber !== undefined) attrs.sheet_number = body.sheetNumber;
  if (body.title !== undefined) attrs.title = body.title;
  if (body.discipline !== undefined) attrs.discipline = body.discipline;
  if (body.revisionLabel !== undefined) attrs.revision_label = body.revisionLabel;
  return { ok: true, ...unwrap<Record<string, unknown>>(await db.schema('pm').rpc('drawing_update_revision', { p_revision: params.revisionId!, p_attrs: attrs })) };
});
