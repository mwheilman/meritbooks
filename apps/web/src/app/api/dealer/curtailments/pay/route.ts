export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { curtailmentPay } from '@/lib/validations/dealer';
import { payCurtailment } from '@/lib/dealer/service/floor-plan';

/**
 * /api/dealer/curtailments/pay — Record a curtailment paid (or the lender auto-debit matched on the bank feed).
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const POST = apiHandler(
  curtailmentPay,
  dealerAction<z.infer<typeof curtailmentPay>>(
    DEALER_PERMS.post,
    async ({ locationId: _l, ...b }, d) => payCurtailment(d, b),
  ),
);
