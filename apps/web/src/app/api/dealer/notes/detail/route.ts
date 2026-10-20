export const dynamic = 'force-dynamic';

import { apiQueryHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { byId } from '@/lib/validations/dealer';
import { getNoteDetail } from '@/lib/dealer/service/floor-plan';

/**
 * /api/dealer/notes/detail — One note with its money events and curtailment schedule.
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const GET = apiQueryHandler(
  byId,
  dealerAction<z.infer<typeof byId>>(
    DEALER_PERMS.view,
    async (b, d) => getNoteDetail(d, b.id),
  ),
);
