export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { goLive } from '@/lib/imports/server';
import { heldMessages } from '@/lib/notify/inbox';

const Query = z.object({ companyId: z.string().uuid() });
const Body = z.object({
  companyId: z.string().uuid(),
  release: z.array(z.string().uuid()).max(200).default([]),
  discard: z.array(z.string().uuid()).max(200).default([]),
});

/** GET /api/onboarding/go-live?companyId — is the company live, and the customer messages held until it is. */
export const GET = route({ access: { cap: 'projects.settings', action: 'configure' }, query: Query, mask: false }, async ({ db, query, tenant }) => {
  assertCompany(tenant, query.companyId);
  const [held, settings] = await Promise.all([
    heldMessages(db, [query.companyId]),
    db.schema('core').from('notification_settings').select('customer_messages_live, live_at').eq('location_id', query.companyId).maybeSingle(),
  ]);
  const s = (settings.data ?? null) as { customer_messages_live: boolean; live_at: string | null } | null;
  return { live: Boolean(s?.customer_messages_live), liveAt: s?.live_at ?? null, held };
});

/** POST /api/onboarding/go-live — customer messages go live; the reviewed held ones are released or discarded. */
export const POST = route({ access: { cap: 'projects.settings', action: 'configure' }, body: Body, mask: false }, async ({ db, body, tenant }) => {
  assertCompany(tenant, body.companyId);
  return goLive(db, body.companyId, body.release, body.discard);
});
