export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { companiesWith } from '@/lib/access/can';
import { actOnHeld, heldMessages } from '@/lib/notify/inbox';
import { HeldBody } from '@/lib/notify/schemas';

/** GET /api/notifications/held — customer messages waiting for go-live (companies where the caller configures settings). */
export const GET = route({ access: { cap: 'projects.settings', action: 'configure' }, mask: false }, async ({ db, access }) => {
  return { items: await heldMessages(db, companiesWith(access, 'projects.settings', 'configure')) };
});

/** POST /api/notifications/held { ids, action: release | discard } — release needs the company to be live; each row is checked at its company. */
export const POST = route({ access: { cap: 'projects.settings', action: 'configure' }, body: HeldBody, mask: false }, async ({ db, body }) => {
  return { updated: await actOnHeld(db, body.ids, body.action) };
});
