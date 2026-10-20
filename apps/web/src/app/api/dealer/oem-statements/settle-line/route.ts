export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { oemLineSettle } from '@/lib/validations/dealer';
import { settleOemLine } from '@/lib/dealer/service/statements';

/**
 * /api/dealer/oem-statements/settle-line — Confirm a proposed (or hand-picked) pair and settle by statement credit.
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const POST = apiHandler(
  oemLineSettle,
  dealerAction<z.infer<typeof oemLineSettle>>(
    DEALER_PERMS.post,
    async (b, d) => {
      const pick = b.claimKind && b.claimId ? { claimKind: b.claimKind, claimId: b.claimId } : undefined;
      await settleOemLine(d, b.lineId, b.date, pick);
      return { settled: true };
    },
  ),
);
