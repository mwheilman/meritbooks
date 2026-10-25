export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { actOnRequest } from '@/lib/approvals/server';
import { RejectBody } from '../../schemas';

/** POST /api/approvals/:id/reject — send it back with a reason (required). */
export const POST = route({ access: 'none', mask: false, body: RejectBody }, async ({ db, params, body }) =>
  actOnRequest(db, params.requestId!, 'reject', { reason: body.reason, channel: body.channel }));
