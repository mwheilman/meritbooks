export const dynamic = 'force-dynamic';

import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction, dealerList } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { importCreate, importUpdate, listQuery } from '@/lib/validations/dealer';
import { createImportBatch, updateImportBatch } from '@/lib/dealer/service/imports';

/**
 * /api/dealer/imports — Import batches (D2 parses; rows carry import_batch_id).
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const GET = apiQueryHandler(listQuery, dealerList('imports', DEALER_PERMS.view));
export const POST = apiHandler(
  importCreate,
  dealerAction<z.infer<typeof importCreate>>(
    DEALER_PERMS.imports,
    async ({ locationId: _l, ...b }, d) => createImportBatch(d, b),
    { status: 201 },
  ),
);
export const PATCH = apiHandler(
  importUpdate,
  dealerAction<z.infer<typeof importUpdate>>(
    DEALER_PERMS.imports,
    async ({ locationId: _l, id, ...b }, d) => updateImportBatch(d, id, b),
  ),
);
