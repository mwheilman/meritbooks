export const dynamic = 'force-dynamic';

import { apiQueryHandler } from '@/lib/api-handler';
import { dealerList } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { listQuery } from '@/lib/validations/dealer';

/**
 * /api/dealer/lender-statements/lines — Statement lines with match status.
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const GET = apiQueryHandler(listQuery, dealerList('lender_statement_lines', DEALER_PERMS.view));
