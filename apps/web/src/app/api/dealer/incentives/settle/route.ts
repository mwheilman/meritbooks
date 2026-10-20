export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { claimSettle } from '@/lib/validations/dealer';
import { settleIncentive } from '@/lib/dealer/service/claims';

/**
 * /api/dealer/incentives/settle — Manufacturer credit or payment against an incentive.
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const POST = apiHandler(
  claimSettle,
  dealerAction<z.infer<typeof claimSettle>>(
    DEALER_PERMS.post,
    async ({ locationId: _l, ...b }, d) => settleIncentive(d, b),
  ),
);
