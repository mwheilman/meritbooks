export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { unitCostPost } from '@/lib/validations/dealer';
import { postUnitCost } from '@/lib/dealer/service/units';

/**
 * /api/dealer/units/costs/post — Post a proposed unit cost row.
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const POST = apiHandler(
  unitCostPost,
  dealerAction<z.infer<typeof unitCostPost>>(
    DEALER_PERMS.post,
    async (b, d) => postUnitCost(d, b.costId, b.entryDate),
  ),
);
