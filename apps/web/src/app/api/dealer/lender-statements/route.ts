export const dynamic = 'force-dynamic';

import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction, dealerList } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { lenderStatementImport, listQuery } from '@/lib/validations/dealer';
import { importLenderStatement } from '@/lib/dealer/service/statements';

/**
 * /api/dealer/lender-statements — Lender statements / floor checks / payoff quotes. POST imports one — rejected (422 NOT_FOOTING) unless lines foot to the footer.
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const GET = apiQueryHandler(listQuery, dealerList('lender_statements', DEALER_PERMS.view));
export const POST = apiHandler(
  lenderStatementImport,
  dealerAction<z.infer<typeof lenderStatementImport>>(
    DEALER_PERMS.edit,
    async ({ locationId: _l, ...b }, d) => importLenderStatement(d, b),
    { status: 201 },
  ),
);
