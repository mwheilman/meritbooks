export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { requestSender } from '@/lib/notify/inbox';
import { SenderBody } from '@/lib/notify/schemas';
import { verifySender } from '@/lib/notify/worker';

/**
 * POST /api/notifications/settings/sender { companyId, phone } — ask for a texting number (as the
 * user, checked at that company), then let the server verify it with Twilio. Only a verified
 * number can be used to send or receive STOP / START; one tenant per number.
 */
export const POST = route({ access: { cap: 'projects.settings', action: 'configure' }, body: SenderBody, mask: false }, async ({ db, body, tenant }) => {
  const ask = await requestSender(db, body.companyId, body.phone);
  if (ask.status === 'verified') return { phone: ask.phone, status: 'verified', reason: null };
  const v = await verifySender(ask.id, tenant.orgId, ask.phone);
  return { phone: ask.phone, ...v };
});
