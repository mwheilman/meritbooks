export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { actOnRequest, afterApproval } from '@/lib/approvals/server';
import { ApproveBody } from '../../schemas';

/**
 * POST /api/approvals/:id/approve — approve the current step (phone + inbox). `selfReason` is the
 * typed reason a solo / two-person company gives to approve its own item (exception report).
 */
export const POST = route({ access: 'none', mask: false, body: ApproveBody }, async ({ db, params, body, tenant }) => {
  const r = await actOnRequest(db, params.requestId!, 'approve', { reason: body.reason ?? null, selfReason: body.selfReason ?? null, channel: body.channel });
  return { ...r, ...(await afterApproval(db, r, tenant.booksPresent)) };
});
