export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { tradeRef } from '@/lib/validations/dealer';
import { approveTrade } from '@/lib/dealer/service/sales';

/**
 * /api/dealer/trade-ins/approve — Sales-manager approval of the trade ACV / over-allowance (invoices:approve).
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const POST = apiHandler(
  tradeRef,
  dealerAction<z.infer<typeof tradeRef>>(
    DEALER_PERMS.approveReceivable,
    async (b, d) => approveTrade(d, b.tradeId),
  ),
);
