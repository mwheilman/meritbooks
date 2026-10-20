export const dynamic = 'force-dynamic';

import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction, dealerList } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { listQuery, warrantyCreate, warrantyUpdate } from '@/lib/validations/dealer';
import { createWarrantyClaim, updateWarrantyClaim } from '@/lib/dealer/service/claims';

/**
 * /api/dealer/warranty — Manufacturer warranty claims.
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const GET = apiQueryHandler(listQuery, dealerList('warranty', DEALER_PERMS.view));
export const POST = apiHandler(
  warrantyCreate,
  dealerAction<z.infer<typeof warrantyCreate>>(
    DEALER_PERMS.edit,
    async ({ locationId: _l, ...b }, d) => createWarrantyClaim(d, b),
    { status: 201 },
  ),
);
export const PATCH = apiHandler(
  warrantyUpdate,
  dealerAction<z.infer<typeof warrantyUpdate>>(
    DEALER_PERMS.edit,
    async ({ locationId: _l, id, ...b }, d) => updateWarrantyClaim(d, id, b),
  ),
);
