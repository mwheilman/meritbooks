export const dynamic = 'force-dynamic';

import { apiQueryHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { locationAsOf } from '@/lib/validations/dealer';
import { todayIso } from '@/lib/dealer/dates';
import { loadSotFindings } from '@/lib/dealer/service/insights';

/**
 * /api/dealer/sot — Sold-out-of-trust findings (books sale unpaid, DMS deal, warranty registration, lender audit).
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const GET = apiQueryHandler(
  locationAsOf,
  dealerAction<z.infer<typeof locationAsOf>>(
    DEALER_PERMS.view,
    async (b, d) => loadSotFindings(d, b.asOf ?? todayIso()),
  ),
);
