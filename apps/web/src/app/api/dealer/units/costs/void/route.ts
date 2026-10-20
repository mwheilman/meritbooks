export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { unitCostVoid } from '@/lib/validations/dealer';
import { voidUnitCost } from '@/lib/dealer/service/units';

/**
 * /api/dealer/units/costs/void — Void a proposed unit cost row.
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const POST = apiHandler(
  unitCostVoid,
  dealerAction<z.infer<typeof unitCostVoid>>(
    DEALER_PERMS.edit,
    async (b, d) => voidUnitCost(d, b.costId),
  ),
);
