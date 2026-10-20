export const dynamic = 'force-dynamic';

import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction, dealerList } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { listQuery, unitCreate, unitUpdate } from '@/lib/validations/dealer';
import { insertUnit, updateUnit } from '@/lib/dealer/service/units';

/**
 * /api/dealer/units — Serialized unit register.
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const GET = apiQueryHandler(listQuery, dealerList('units', DEALER_PERMS.view));
export const POST = apiHandler(
  unitCreate,
  dealerAction<z.infer<typeof unitCreate>>(
    DEALER_PERMS.edit,
    async ({ locationId: _l, ...b }, d) => insertUnit(d, { ...b, source: b.source ?? 'MANUAL' }),
    { status: 201 },
  ),
);
export const PATCH = apiHandler(
  unitUpdate,
  dealerAction<z.infer<typeof unitUpdate>>(
    DEALER_PERMS.edit,
    async ({ locationId: _l, id, ...b }, d) => updateUnit(d, id, b),
  ),
);
