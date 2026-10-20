export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { saleRef } from '@/lib/validations/dealer';
import { postSale } from '@/lib/dealer/service/sales';

/**
 * /api/dealer/sales/post — Post a deal: deal JE (+ Books invoice in DEAL mode), deposit applied, used unit from the trade, retail rebate receivable, note → sold-unpaid, payoff proposed.
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const POST = apiHandler(
  saleRef,
  dealerAction<z.infer<typeof saleRef>>(
    DEALER_PERMS.post,
    async (b, d) => postSale(d, b.saleId),
  ),
);
