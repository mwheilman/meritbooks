export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { createMarkup, listMarkups } from '@/lib/documents/drawings';
import { MarkupInput, parseGeometry } from '@/lib/documents/types';

/** GET …/markups — your personal markups and every published one on this revision (RLS). */
export const GET = route({ access: { cap: 'projects.documents', action: 'view' }, mask: false }, async ({ db, params }) => ({ markups: await listMarkups(db, params.revisionId!) }));

/** POST …/markups — add a pin / rectangle / cloud / arrow / freehand / text markup (publishing needs documents:edit). */
export const POST = route({ access: { cap: 'projects.documents', action: 'create' }, mask: false, body: MarkupInput }, async ({ db, params, body }) => {
  const geometry = parseGeometry(body.kind, body.geometry) ?? {};
  return { ok: true, markup: await createMarkup(db, params.revisionId!, { ...body, geometry }) };
});
