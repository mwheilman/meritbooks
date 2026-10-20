export const dynamic = 'force-dynamic';

import { apiQueryHandler } from '@/lib/api-handler';
import { dealerList } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { listQuery } from '@/lib/validations/dealer';

/**
 * /api/dealer/oem-statements/lines — Manufacturer statement lines with proposed matches.
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const GET = apiQueryHandler(listQuery, dealerList('oem_statement_lines', DEALER_PERMS.view));
