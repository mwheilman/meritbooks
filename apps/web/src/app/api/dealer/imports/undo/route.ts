export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { byId } from '@/lib/validations/dealer';
import { undoImportBatch } from '@/lib/dealer/service/imports';

/**
 * /api/dealer/imports/undo — Undo an import batch whose rows have not posted.
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const POST = apiHandler(
  byId,
  dealerAction<z.infer<typeof byId>>(
    DEALER_PERMS.imports,
    async (b, d) => undoImportBatch(d, b.id),
  ),
);
