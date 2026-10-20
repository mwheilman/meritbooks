export const dynamic = 'force-dynamic';

import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction, dealerList } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { listQuery, oemProgramCreate, oemProgramUpdate } from '@/lib/validations/dealer';
import { createOemProgram, updateOemProgram } from '@/lib/dealer/service/claims';

/**
 * /api/dealer/oem-programs — Manufacturer incentive programs (created DRAFT).
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const GET = apiQueryHandler(listQuery, dealerList('oem_programs', DEALER_PERMS.view));
export const POST = apiHandler(
  oemProgramCreate,
  dealerAction<z.infer<typeof oemProgramCreate>>(
    DEALER_PERMS.settings,
    async ({ locationId: _l, ...b }, d) => createOemProgram(d, b),
    { status: 201 },
  ),
);
export const PATCH = apiHandler(
  oemProgramUpdate,
  dealerAction<z.infer<typeof oemProgramUpdate>>(
    DEALER_PERMS.settings,
    async ({ locationId: _l, id, ...b }, d) => updateOemProgram(d, id, b),
  ),
);
