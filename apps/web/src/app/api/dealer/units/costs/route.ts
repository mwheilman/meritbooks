export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { unitCostAdd } from '@/lib/validations/dealer';
import { addUnitCost } from '@/lib/dealer/service/units';

/**
 * /api/dealer/units/costs — Add a cost row to a unit (bill line link, internal setup RO at actual cost, or direct addition). post=true posts now (needs journal_entries:post).
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const POST = apiHandler(
  unitCostAdd,
  dealerAction<z.infer<typeof unitCostAdd>>(
    (b) => (b.post && b.sourceType !== 'BILL_LINE' ? DEALER_PERMS.post : DEALER_PERMS.edit),
    async ({ locationId: _l, ...b }, d) => addUnitCost(d, { ...b, post: b.post === true }),
    { status: 201 },
  ),
);
