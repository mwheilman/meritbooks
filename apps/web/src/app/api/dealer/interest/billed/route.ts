export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { interestBilled } from '@/lib/validations/dealer';
import { recordInterestBilled } from '@/lib/dealer/service/floor-plan';

/**
 * /api/dealer/interest/billed — Lender interest bill/debit: clears the accrual and books the true-up. Over tolerance → 409 INTEREST_VARIANCE (DL-9) unless acceptVariance (close_mgmt:manage).
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const POST = apiHandler(
  interestBilled,
  dealerAction<z.infer<typeof interestBilled>>(
    (b) => (b.acceptVariance ? DEALER_PERMS.approveUnit : DEALER_PERMS.post),
    async ({ locationId: _l, ...b }, d) => recordInterestBilled(d, b),
  ),
);
