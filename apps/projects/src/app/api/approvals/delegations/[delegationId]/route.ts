export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { revokeDelegation } from '@/lib/approvals/server';

/** DELETE /api/approvals/delegations/:id — end the cover now (kept in history). */
export const DELETE = route({ access: 'none', mask: false }, async ({ db, params }) => {
  await revokeDelegation(db, params.delegationId!);
  return { ok: true };
});
