export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { unitAction } from '@/lib/validations/dealer';
import { applyUnitAction, unitActionNeedsApproval } from '@/lib/dealer/service/units';

/**
 * /api/dealer/units/actions — Unit status actions: demo, rental move, write-down, return to OEM, warranty registration, delivered, void. GL-moving actions need controller approval (close_mgmt:manage).
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const POST = apiHandler(
  unitAction,
  dealerAction<z.infer<typeof unitAction>>(
    (b) => (unitActionNeedsApproval(b.action.action) ? DEALER_PERMS.approveUnit : DEALER_PERMS.edit),
    async (b, d) => applyUnitAction(d, b.unitId, b.action),
  ),
);
