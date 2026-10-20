export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { deptMapBody } from '@/lib/validations/dealer';
import { mapDepartments, readiness } from '@/lib/dealer/service/settings';

/**
 * /api/dealer/settings/departments — Map the pack's department roles to this client's departments.
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const PUT = apiHandler(
  deptMapBody,
  dealerAction<z.infer<typeof deptMapBody>>(
    DEALER_PERMS.settings,
    async (b, d) => {
      await mapDepartments(d, b.mappings);
      return readiness(d);
    },
  ),
);
