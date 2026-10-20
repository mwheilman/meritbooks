export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { txnRef } from '@/lib/validations/dealer';
import { postFlooring } from '@/lib/dealer/service/floor-plan';

/**
 * /api/dealer/floor/post — Approve + post a proposed flooring.
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const POST = apiHandler(
  txnRef,
  dealerAction<z.infer<typeof txnRef>>(
    DEALER_PERMS.post,
    async (b, d) => postFlooring(d, b.txnId),
  ),
);
