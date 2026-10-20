export const dynamic = 'force-dynamic';

import { apiQueryHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { locationOnly } from '@/lib/validations/dealer';
import { evaluateTieout } from '@/lib/dealer/engine/summary';
import { loadTieout } from '@/lib/dealer/service/settings';

/**
 * /api/dealer/tieout — Subledger ↔ GL tie-out by role account (v_dealer_subledger_tieout).
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const GET = apiQueryHandler(
  locationOnly,
  dealerAction<z.infer<typeof locationOnly>>(
    DEALER_PERMS.view,
    async (_b, d) => {
      const rows = await loadTieout(d);
      return { ...evaluateTieout(rows), rows };
    },
  ),
);
