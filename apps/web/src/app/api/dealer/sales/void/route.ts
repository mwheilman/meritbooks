export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { saleVoid } from '@/lib/validations/dealer';
import { voidSale } from '@/lib/dealer/service/sales';

/**
 * /api/dealer/sales/void — Void an unposted deal.
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const POST = apiHandler(
  saleVoid,
  dealerAction<z.infer<typeof saleVoid>>(
    DEALER_PERMS.edit,
    async (b, d) => voidSale(d, b.saleId, b.reason),
  ),
);
