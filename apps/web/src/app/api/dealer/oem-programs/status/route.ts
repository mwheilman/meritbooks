export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { oemProgramStatus } from '@/lib/validations/dealer';
import { setOemProgramStatus } from '@/lib/dealer/service/claims';

/**
 * /api/dealer/oem-programs/status — Approve (ACTIVE) or expire a program.
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const POST = apiHandler(
  oemProgramStatus,
  dealerAction<z.infer<typeof oemProgramStatus>>(
    DEALER_PERMS.settings,
    async (b, d) => setOemProgramStatus(d, b.id, b.status),
  ),
);
