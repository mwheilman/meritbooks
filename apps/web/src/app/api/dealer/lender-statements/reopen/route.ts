export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { statementRef } from '@/lib/validations/dealer';
import { reopenLenderStatement } from '@/lib/dealer/service/statements';

/**
 * /api/dealer/lender-statements/reopen — Send a prepared reconciliation back to matching.
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const POST = apiHandler(
  statementRef,
  dealerAction<z.infer<typeof statementRef>>(
    DEALER_PERMS.reconcile,
    async (b, d) => reopenLenderStatement(d, b.statementId),
  ),
);
