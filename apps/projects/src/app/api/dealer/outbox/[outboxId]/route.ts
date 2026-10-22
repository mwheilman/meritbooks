export const dynamic = 'force-dynamic';

import { assertCompany, route } from '@/lib/api';
import { dcall, downs } from '@/lib/pm/dealer/rpc';

/** Re-send a dealer event Merit Books rejected, once the cause is fixed in Books (pm.resend_dealer_event; same source_ref). */
export const POST = route({ access: { cap: 'projects.store', action: 'approve' }, mask: false }, async ({ db, params, tenant }) => {
  const o = await downs<{ id: string; location_id: string }>(db, 'dealer_outbox', 'id, location_id', params.outboxId!, 'That event was not found.');
  assertCompany(tenant, o.location_id);
  const eventId = await dcall<string>(db, 'resend_dealer_event', { p_outbox: o.id });
  return { ok: true, eventId };
});
