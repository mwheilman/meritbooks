export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { SpecUpdate, toColumns } from '@/lib/commercial/screen-schemas';
import { cmWrote } from '@/lib/commercial/server';

const COLS = { title: 'title', revision: 'revision', addendum: 'addendum', pageStart: 'page_start', pageEnd: 'page_end' } as const;

/** PATCH /api/commercial/specs/:id — retitle a section, record an addendum revision, or its pages in the manual. */
export const PATCH = route({ access: { cap: 'projects.documents', action: 'create' }, mask: false, body: SpecUpdate }, async ({ db, body, params }) => {
  const patch = toColumns(body, COLS);
  if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
  return cmWrote<{ id: string }>(await db.schema('pm').from('cm_spec_sections').update(patch).eq('id', params.sectionId!).select('id').single());
});

/** DELETE /api/commercial/specs/:id — remove a section that was imported by mistake. */
export const DELETE = route({ access: { cap: 'projects.documents', action: 'create' }, mask: false }, async ({ db, params }) => {
  return cmWrote<{ id: string }>(await db.schema('pm').from('cm_spec_sections').delete().eq('id', params.sectionId!).select('id').single());
});
