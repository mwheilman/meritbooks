export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { claimSettle } from '@/lib/validations/dealer';
import { settleWarrantyClaim } from '@/lib/dealer/service/claims';

/**
 * /api/dealer/warranty/settle — Manufacturer credit or payment against a claim.
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const POST = apiHandler(
  claimSettle,
  dealerAction<z.infer<typeof claimSettle>>(
    DEALER_PERMS.post,
    async ({ locationId: _l, ...b }, d) => settleWarrantyClaim(d, b),
  ),
);
