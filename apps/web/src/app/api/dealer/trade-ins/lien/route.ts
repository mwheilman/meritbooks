export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { tradeLien } from '@/lib/validations/dealer';
import { proposeLienPayoff, releaseLienPayoff } from '@/lib/dealer/service/sales';

/**
 * /api/dealer/trade-ins/lien — Trade lien payoff: propose, then release by a different person (payments_execute:run).
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const POST = apiHandler(
  tradeLien,
  dealerAction<z.infer<typeof tradeLien>>(
    (b) => (b.action === 'release' ? DEALER_PERMS.release : DEALER_PERMS.edit),
    async (b, d) => (b.action === 'release' ? releaseLienPayoff(d, b.tradeId, b.paidDate) : proposeLienPayoff(d, b.tradeId)),
  ),
);
