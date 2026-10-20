export const dynamic = 'force-dynamic';

import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction, dealerList } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { lineCreate, lineUpdate, listQuery } from '@/lib/validations/dealer';
import { createLine, updateLine } from '@/lib/dealer/service/floor-plan';

/**
 * /api/dealer/lines — Floor-plan lender lines.
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const GET = apiQueryHandler(listQuery, dealerList('lines', DEALER_PERMS.view));
export const POST = apiHandler(
  lineCreate,
  dealerAction<z.infer<typeof lineCreate>>(
    DEALER_PERMS.settings,
    async ({ locationId: _l, ...b }, d) => createLine(d, b),
    { status: 201 },
  ),
);
export const PATCH = apiHandler(
  lineUpdate,
  dealerAction<z.infer<typeof lineUpdate>>(
    DEALER_PERMS.settings,
    async ({ locationId: _l, id, ...b }, d) => updateLine(d, id, b),
  ),
);
