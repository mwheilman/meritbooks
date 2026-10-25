export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { setRevisions } from '@/lib/documents/drawings';
import { unwrap } from '@/lib/documents/errors';

/** GET /api/documents/drawings/sets/:setId — the set's pages for review (number, title, extraction confidence). */
export const GET = route({ access: { cap: 'projects.documents', action: 'view' }, mask: false }, async ({ db, params }) => ({ revisions: await setRevisions(db, params.setId!) }));

/** POST /api/documents/drawings/sets/:setId — publish: its sheets become current where this is the latest set. */
export const POST = route({ access: { cap: 'projects.documents', action: 'edit' }, mask: false }, async ({ db, params }) => {
  return { ok: true, ...unwrap<Record<string, unknown>>(await db.schema('pm').rpc('drawing_publish_set', { p_set: params.setId! })) };
});
