export const dynamic = 'force-dynamic';

import { apiQueryHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { byId } from '@/lib/validations/dealer';
import { getUnitDetail } from '@/lib/dealer/service/units';

/**
 * /api/dealer/units/detail — One unit with its cost build-up, notes and sale.
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const GET = apiQueryHandler(
  byId,
  dealerAction<z.infer<typeof byId>>(
    DEALER_PERMS.view,
    async (b, d) => getUnitDetail(d, b.id),
  ),
);
