export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { txnVoid } from '@/lib/validations/dealer';
import { voidFlooring } from '@/lib/dealer/service/floor-plan';

/**
 * /api/dealer/floor/void — Void a proposed (never posted) flooring.
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const POST = apiHandler(
  txnVoid,
  dealerAction<z.infer<typeof txnVoid>>(
    DEALER_PERMS.edit,
    async (b, d) => {
      await voidFlooring(d, b.txnId, b.reason);
      return { voided: true };
    },
  ),
);
