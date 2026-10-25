export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { FadeAlertAction } from '@/lib/commercial/screen-schemas';
import { cmWrote } from '@/lib/commercial/server';

/** POST /api/commercial/productivity/alerts/:id — acknowledge or resolve a fade alert. */
export const POST = route({ access: { cap: 'projects.time', action: 'approve' }, mask: false, body: FadeAlertAction }, async ({ db, body, params, userId }) => {
  return cmWrote<{ id: string; status: string }>(await db.schema('pm').from('cm_fade_alerts').update({ status: body.status, acknowledged_by: body.status === 'OPEN' ? null : userId })
    .eq('id', params.alertId!).select('id, status').single());
});
