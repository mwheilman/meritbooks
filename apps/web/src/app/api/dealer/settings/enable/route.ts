export const dynamic = 'force-dynamic';

import { apiHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { enableBody } from '@/lib/validations/dealer';
import { setEnabled } from '@/lib/dealer/service/settings';

/**
 * /api/dealer/settings/enable — Switch the pack on/off for the client. Enabling is refused (409 ENABLE_BLOCKED) until roles, departments and the opening tie-out are complete.
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const POST = apiHandler(
  enableBody,
  dealerAction<z.infer<typeof enableBody>>(
    DEALER_PERMS.settings,
    async (b, d) => setEnabled(d, b.enabled),
  ),
);
