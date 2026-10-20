export const dynamic = 'force-dynamic';

import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction, dealerList } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { listQuery, programCreate, programUpdate } from '@/lib/validations/dealer';
import { createProgram, updateProgram } from '@/lib/dealer/service/floor-plan';

/**
 * /api/dealer/programs — Floor-plan programs (rate, free floor, curtailment schedule, payoff terms) under a line.
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const GET = apiQueryHandler(listQuery, dealerList('programs', DEALER_PERMS.view));
export const POST = apiHandler(
  programCreate,
  dealerAction<z.infer<typeof programCreate>>(
    DEALER_PERMS.settings,
    async ({ locationId: _l, ...b }, d) => createProgram(d, b),
    { status: 201 },
  ),
);
export const PATCH = apiHandler(
  programUpdate,
  dealerAction<z.infer<typeof programUpdate>>(
    DEALER_PERMS.settings,
    async ({ locationId: _l, id, ...b }, d) => updateProgram(d, id, b),
  ),
);
