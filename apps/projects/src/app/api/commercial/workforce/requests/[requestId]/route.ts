export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { RequestUpdate } from '@/lib/commercial/screen-schemas';
import { cmWrote } from '@/lib/commercial/server';

/** PATCH /api/commercial/workforce/requests/:id — mark a crew request partly filled, filled or cancelled. */
export const PATCH = route({ access: { cap: 'projects.jobs', action: 'edit' }, mask: false, body: RequestUpdate }, async ({ db, body, params }) => {
  return cmWrote<{ id: string }>(await db.schema('pm').from('cm_workforce_requests').update({ status: body.status }).eq('id', params.requestId!).select('id').single());
});
