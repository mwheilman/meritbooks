export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { warrantySubmit } from '@/lib/validations/dealer';
import { submitWarrantyClaim } from '@/lib/dealer/service/claims';

/**
 * /api/dealer/warranty/submit — Submit a claim (recognizes the receivable if not already).
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const POST = apiHandler(
  warrantySubmit,
  dealerAction<z.infer<typeof warrantySubmit>>(
    DEALER_PERMS.post,
    async (b, d) => submitWarrantyClaim(d, b.claimId, b.submittedDate, b.oemClaimNumber),
  ),
);
