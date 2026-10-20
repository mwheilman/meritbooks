export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { payoffPropose } from '@/lib/validations/dealer';
import { proposePayoff } from '@/lib/dealer/service/floor-plan';

/**
 * /api/dealer/payoffs/propose — Propose a payoff for a note (a sale proposes one automatically).
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const POST = apiHandler(
  payoffPropose,
  dealerAction<z.infer<typeof payoffPropose>>(
    DEALER_PERMS.edit,
    async (b, d) => proposePayoff(d, b.noteId, b.date),
    { status: 201 },
  ),
);
