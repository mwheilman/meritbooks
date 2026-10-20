export const dynamic = 'force-dynamic';

import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { locationOnly, settingsPatch } from '@/lib/validations/dealer';
import { loadSettings, readiness, saveSettings } from '@/lib/dealer/service/settings';

/**
 * /api/dealer/settings — Per-client dealer pack settings + readiness (role map, department map, opening tie-out).
 * Contract: docs/dealer-pack-api.md. Org is pinned from the session; locationId is the client.
 */
export const GET = apiQueryHandler(
  locationOnly,
  dealerAction<z.infer<typeof locationOnly>>(
    DEALER_PERMS.view,
    async (_b, d) => ({ settings: await loadSettings(d), readiness: await readiness(d) }),
  ),
);
export const PUT = apiHandler(
  settingsPatch,
  dealerAction<z.infer<typeof settingsPatch>>(
    DEALER_PERMS.settings,
    async ({ locationId: _l, ...patch }, d) => saveSettings(d, patch),
  ),
);
