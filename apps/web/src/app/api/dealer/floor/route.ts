export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { floorBody } from '@/lib/validations/dealer';
import { floorUnit } from '@/lib/dealer/service/floor-plan';

/**
 * /api/dealer/floor — Record a flooring (lender paid the manufacturer): unit + note + FLOOR transaction. PROPOSED by default; postNow posts (journal_entries:post); viaImport lets the DEALER_FLOORING autonomy dial decide; opening loads a go-live balance with no GL.
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const POST = apiHandler(
  floorBody,
  dealerAction<z.infer<typeof floorBody>>(
    (b) => (b.postNow ? DEALER_PERMS.post : DEALER_PERMS.edit),
    async ({ locationId: _l, postNow, viaImport, ...b }, d) =>
      floorUnit(d, b, postNow ? 'POST_NOW' : viaImport ? 'AUTONOMY' : 'PROPOSE'),
    { status: 201 },
  ),
);
