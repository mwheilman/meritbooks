export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { curtailmentWaive } from '@/lib/validations/dealer';
import { waiveCurtailment } from '@/lib/dealer/service/floor-plan';

/**
 * /api/dealer/curtailments/waive — Waive a curtailment (lender agreed).
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const POST = apiHandler(
  curtailmentWaive,
  dealerAction<z.infer<typeof curtailmentWaive>>(
    DEALER_PERMS.approveUnit,
    async (b, d) => {
      await waiveCurtailment(d, b.curtailmentId, b.reason);
      return { waived: true };
    },
  ),
);
