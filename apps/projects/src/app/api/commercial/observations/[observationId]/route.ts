export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { ObservationAction } from '@/lib/commercial/schemas';
import { cmWrote } from '@/lib/commercial/server';

/** POST /api/commercial/observations/:id — move it along: in progress, ready for review, closed. */
export const POST = route({ access: { cap: 'projects.jobs', action: 'edit' }, mask: false, body: ObservationAction }, async ({ db, body, params }) => {
  return cmWrote<{ id: string; status: string }>(await db.schema('pm').from('cm_observations').update({
    status: body.status, closed_at: body.status === 'CLOSED' ? new Date().toISOString() : null,
  }).eq('id', params.observationId!).select('id, status').single());
});
