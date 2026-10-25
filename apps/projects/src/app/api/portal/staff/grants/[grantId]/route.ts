export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { revoke, UpdateGrantBody, updateGrant } from '@/lib/portal/staff';

/** PATCH — change role / who can sign / pay / jobs / expiry. DELETE — remove portal access now. Guarded in the database by audience. */
export const PATCH = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, body: UpdateGrantBody }, async ({ db, params, body }) => ({
  ok: true, grant: await updateGrant(db, params.grantId, body),
}));

const RevokeQuery = z.object({ reason: z.string().trim().max(500).optional() });
export const DELETE = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, query: RevokeQuery }, async ({ db, params, query }) => {
  await revoke(db, params.grantId, query.reason ?? null);
  return { ok: true };
});
