export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { warrantyRoClose } from '@/lib/validations/dealer';
import { closeRepairOrder } from '@/lib/dealer/service/claims';

/**
 * /api/dealer/warranty/ro-close — Repair order closed (recognizes the receivable when the client policy is ON_RO_CLOSE).
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const POST = apiHandler(
  warrantyRoClose,
  dealerAction<z.infer<typeof warrantyRoClose>>(
    DEALER_PERMS.post,
    async (b, d) => closeRepairOrder(d, b.claimId, b.roClosedDate),
  ),
);
