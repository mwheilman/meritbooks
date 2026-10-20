export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { statementLineResolve } from '@/lib/validations/dealer';
import { resolveStatementLine } from '@/lib/dealer/service/statements';

/**
 * /api/dealer/lender-statements/resolve-line — Resolve a variance / lender-only / books-only line with a note.
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const POST = apiHandler(
  statementLineResolve,
  dealerAction<z.infer<typeof statementLineResolve>>(
    DEALER_PERMS.reconcile,
    async (b, d) => {
      await resolveStatementLine(d, b.lineId, b.resolution);
      return { resolved: true };
    },
  ),
);
