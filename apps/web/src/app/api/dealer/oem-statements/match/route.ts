export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { statementRef } from '@/lib/validations/dealer';
import { matchOemStatement } from '@/lib/dealer/service/statements';

/**
 * /api/dealer/oem-statements/match — Deterministic credit ↔ claim matching; exact pairs auto-settle only when the DEALER_OEM_CREDIT_MATCH dial allows.
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const POST = apiHandler(
  statementRef,
  dealerAction<z.infer<typeof statementRef>>(
    DEALER_PERMS.post,
    async (b, d) => matchOemStatement(d, b.statementId),
  ),
);
