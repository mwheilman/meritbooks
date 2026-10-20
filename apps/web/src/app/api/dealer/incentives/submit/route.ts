export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { incentiveSubmit } from '@/lib/validations/dealer';
import { submitIncentive } from '@/lib/dealer/service/claims';

/**
 * /api/dealer/incentives/submit — Submit (or resubmit) an incentive claim.
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const POST = apiHandler(
  incentiveSubmit,
  dealerAction<z.infer<typeof incentiveSubmit>>(
    DEALER_PERMS.edit,
    async (b, d) => submitIncentive(d, b.claimId, b.submittedDate, b.claimedCents, b.claimReference),
  ),
);
