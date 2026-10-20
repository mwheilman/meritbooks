export const dynamic = 'force-dynamic';

import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction, dealerList } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { listQuery, oemStatementImport } from '@/lib/validations/dealer';
import { importOemStatement } from '@/lib/dealer/service/statements';

/**
 * /api/dealer/oem-statements — Manufacturer statements. POST imports one (lines must sum to the footer).
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const GET = apiQueryHandler(listQuery, dealerList('oem_statements', DEALER_PERMS.view));
export const POST = apiHandler(
  oemStatementImport,
  dealerAction<z.infer<typeof oemStatementImport>>(
    DEALER_PERMS.edit,
    async ({ locationId: _l, ...b }, d) => importOemStatement(d, b),
    { status: 201 },
  ),
);
