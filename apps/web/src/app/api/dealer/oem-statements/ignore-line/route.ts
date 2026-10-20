export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { oemLineRef } from '@/lib/validations/dealer';
import { ignoreOemLine } from '@/lib/dealer/service/statements';

/**
 * /api/dealer/oem-statements/ignore-line — Ignore a line (not a claim credit).
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const POST = apiHandler(
  oemLineRef,
  dealerAction<z.infer<typeof oemLineRef>>(
    DEALER_PERMS.edit,
    async (b, d) => {
      await ignoreOemLine(d, b.lineId);
      return { ignored: true };
    },
  ),
);
