export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { interestAccrue } from '@/lib/validations/dealer';
import { accrueInterest } from '@/lib/dealer/service/floor-plan';

/**
 * /api/dealer/interest/accrue — Interest accrual through periodEnd. post=false previews (and stores PROPOSED rows); post=true posts one batch JE.
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const POST = apiHandler(
  interestAccrue,
  dealerAction<z.infer<typeof interestAccrue>>(
    (b) => (b.post ? DEALER_PERMS.post : DEALER_PERMS.edit),
    async (b, d) => accrueInterest(d, { periodEnd: b.periodEnd, post: b.post === true }),
  ),
);
