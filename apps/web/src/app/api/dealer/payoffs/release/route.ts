export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { payoffRelease } from '@/lib/validations/dealer';
import { releasePayoff } from '@/lib/dealer/service/floor-plan';

/**
 * /api/dealer/payoffs/release — Release a proposed payoff: a different person than the proposer, with the money-movement permission. Never automatic.
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const POST = apiHandler(
  payoffRelease,
  dealerAction<z.infer<typeof payoffRelease>>(
    DEALER_PERMS.release,
    async ({ locationId: _l, txnId, ...b }, d) => releasePayoff(d, txnId, b),
  ),
);
