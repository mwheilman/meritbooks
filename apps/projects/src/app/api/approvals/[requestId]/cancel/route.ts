export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { cancelRequest } from '@/lib/approvals/server';
import { CancelBody } from '../../schemas';

/** POST /api/approvals/:id/cancel — the sender (or a settings owner) withdraws it. */
export const POST = route({ access: 'none', mask: false, body: CancelBody }, async ({ db, params, body }) =>
  cancelRequest(db, params.requestId!, body.reason ?? null));
