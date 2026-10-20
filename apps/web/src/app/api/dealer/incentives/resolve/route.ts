export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { incentiveResolve } from '@/lib/validations/dealer';
import { resolveIncentive } from '@/lib/dealer/service/claims';

/**
 * /api/dealer/incentives/resolve — Write off (invoices:approve) or record a rejection.
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const POST = apiHandler(
  incentiveResolve,
  dealerAction<z.infer<typeof incentiveResolve>>(
    (b) => (b.resolution.action === 'WRITE_OFF' ? DEALER_PERMS.approveReceivable : DEALER_PERMS.edit),
    async (b, d) => resolveIncentive(d, b.claimId, b.resolution),
  ),
);
