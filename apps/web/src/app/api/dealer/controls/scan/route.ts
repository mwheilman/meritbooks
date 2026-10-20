export const dynamic = 'force-dynamic';

import type { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { dealerControlsScan } from '@/lib/validations/dealer-d2';
import { scanDealerControls } from '@/lib/controls/dealer';

/**
 * POST /api/dealer/controls/scan { locationId } — run the dealer exception checks
 * for one client now (dealer home "Scan now"). Detect-only: the only write is
 * PROPOSED / EXPIRED rows in ai_decisions, through the caller's RLS client.
 * → { data: { queued, expired, byDetector, errors } }
 */
export const POST = apiHandler(
  dealerControlsScan,
  dealerAction<z.infer<typeof dealerControlsScan>>(DEALER_PERMS.view, async (b, d) => {
    const r = await scanDealerControls(d.db, d.orgId, { locationId: b.locationId });
    return { queued: r.queued, expired: r.expired, byDetector: r.byDetector, errors: r.errors };
  }),
);
