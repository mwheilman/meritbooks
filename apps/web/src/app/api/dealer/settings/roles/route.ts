export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { roleMapBody } from '@/lib/validations/dealer';
import { mapRoles, readiness } from '@/lib/dealer/service/settings';

/**
 * /api/dealer/settings/roles — Map account roles to this client's accounts (accountId null removes the client mapping).
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const PUT = apiHandler(
  roleMapBody,
  dealerAction<z.infer<typeof roleMapBody>>(
    DEALER_PERMS.settings,
    async (b, d) => {
      await mapRoles(d, b.mappings);
      return readiness(d);
    },
  ),
);
