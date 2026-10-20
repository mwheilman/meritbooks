export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { warrantyResolve } from '@/lib/validations/dealer';
import { resolveWarrantyClaim, warrantyResolutionNeedsApproval } from '@/lib/dealer/service/claims';

/**
 * /api/dealer/warranty/resolve — Accept short-pay / write off / debit (invoices:approve) or record a rejection / resubmission.
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const POST = apiHandler(
  warrantyResolve,
  dealerAction<z.infer<typeof warrantyResolve>>(
    (b) => (warrantyResolutionNeedsApproval(b.resolution.action) ? DEALER_PERMS.approveReceivable : DEALER_PERMS.edit),
    async (b, d) => resolveWarrantyClaim(d, b.claimId, b.resolution),
  ),
);
