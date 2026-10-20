export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { feeBody } from '@/lib/validations/dealer';
import { recordFee } from '@/lib/dealer/service/floor-plan';

/**
 * /api/dealer/fees — Lender late / audit / other fees.
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const POST = apiHandler(
  feeBody,
  dealerAction<z.infer<typeof feeBody>>(
    DEALER_PERMS.post,
    async ({ locationId: _l, ...b }, d) => recordFee(d, b),
    { status: 201 },
  ),
);
