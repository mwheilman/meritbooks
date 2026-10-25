export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { deleteMarkup, publishMarkup, updateMarkup } from '@/lib/documents/drawings';
import { unwrap } from '@/lib/documents/errors';
import { MarkupStyle, parseGeometry, type MarkupKind } from '@/lib/documents/types';

const Patch = z.object({
  geometry: z.unknown().optional(),
  style: MarkupStyle.optional(),
  body: z.string().trim().max(2000).nullable().optional(),
  publish: z.boolean().optional(),
});

/** PATCH …/markups/:markupId — move / restyle / edit text (author's personal, or published with documents:edit); publish or unpublish. */
export const PATCH = route({ access: { cap: 'projects.documents', action: 'create' }, mask: false, body: Patch }, async ({ db, params, body }) => {
  const id = params.markupId!;
  if (body.publish !== undefined) await publishMarkup(db, id, body.publish);
  if (body.geometry !== undefined || body.style !== undefined || body.body !== undefined) {
    const cur = unwrap<{ kind: MarkupKind } | null>(await db.schema('pm').from('drawing_markups').select('kind').eq('id', id).maybeSingle());
    if (!cur) throw new HttpError(404, 'That markup was not found.', 'NOT_FOUND');
    const geometry = body.geometry === undefined ? undefined : parseGeometry(cur.kind, body.geometry);
    if (body.geometry !== undefined && !geometry) throw new HttpError(422, `Not a valid ${cur.kind} shape.`, 'VALIDATION');
    return { ok: true, markup: await updateMarkup(db, id, { geometry: geometry ?? undefined, style: body.style, body: body.body ?? undefined }) };
  }
  return { ok: true };
});

/** DELETE …/markups/:markupId */
export const DELETE = route({ access: { cap: 'projects.documents', action: 'create' }, mask: false }, async ({ db, params }) => {
  await deleteMarkup(db, params.markupId!);
  return { ok: true };
});
