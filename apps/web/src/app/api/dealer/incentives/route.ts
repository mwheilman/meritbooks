export const dynamic = 'force-dynamic';

import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction, dealerList } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { incentiveAccrue, listQuery } from '@/lib/validations/dealer';
import { accrueIncentive } from '@/lib/dealer/service/claims';

/**
 * /api/dealer/incentives — Incentive claims. POST accrues one under an active program (GL per the program treatment).
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const GET = apiQueryHandler(listQuery, dealerList('incentives', DEALER_PERMS.view));
export const POST = apiHandler(
  incentiveAccrue,
  dealerAction<z.infer<typeof incentiveAccrue>>(
    DEALER_PERMS.post,
    async ({ locationId: _l, ...b }, d) => accrueIncentive(d, b),
    { status: 201 },
  ),
);
