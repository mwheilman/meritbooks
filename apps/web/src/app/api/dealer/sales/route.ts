export const dynamic = 'force-dynamic';

import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction, dealerList } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { listQuery, saleCreate } from '@/lib/validations/dealer';
import { createSale } from '@/lib/dealer/service/sales';

/**
 * /api/dealer/sales — Unit sales (deals). POST records a PROPOSED deal (DMS imports land here).
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const GET = apiQueryHandler(listQuery, dealerList('sales', DEALER_PERMS.view));
export const POST = apiHandler(
  saleCreate,
  dealerAction<z.infer<typeof saleCreate>>(
    DEALER_PERMS.edit,
    async ({ locationId: _l, ...b }, d) => createSale(d, b),
    { status: 201 },
  ),
);
