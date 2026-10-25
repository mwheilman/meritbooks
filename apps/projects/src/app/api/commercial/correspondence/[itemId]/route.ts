export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { DocControlStatus } from '@/lib/commercial/screen-schemas';
import { cmWrote } from '@/lib/commercial/server';

/**
 * POST /api/commercial/correspondence/:id — move a transmittal (sent, acknowledged) or a letter /
 * notice (sent, received, responded, closed) along. The table's trigger stamps the dates and locks
 * an acknowledged transmittal.
 */
export const POST = route({ access: { cap: 'projects.documents', action: 'create' }, mask: false, body: DocControlStatus }, async ({ db, body, params }) => {
  const pm = db.schema('pm');
  if (body.kind === 'transmittal') {
    return cmWrote<{ id: string; status: string }>(await pm.from('cm_transmittals').update({
      status: body.status, ...(body.status === 'ACKNOWLEDGED' && body.acknowledgedBy ? { acknowledged_by: body.acknowledgedBy } : {}),
    }).eq('id', params.itemId!).select('id, status').single());
  }
  return cmWrote<{ id: string; status: string }>(await pm.from('cm_correspondence').update({
    status: body.status, ...(body.status === 'RESPONDED' && body.respondedOn ? { responded_on: body.respondedOn } : {}),
  }).eq('id', params.itemId!).select('id, status').single());
});
