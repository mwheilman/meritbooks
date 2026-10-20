export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { one, pm } from '@/lib/pm/db';
import { callRpc } from '@/lib/pm/money/rpc';

const Body = z.object({ op: z.literal('resend') });

/** pm.reemit_deposit_request: send a deposit request Merit Books rejected again (new event, same source_ref). */
export const POST = route({ body: Body }, async ({ db, params }) => {
  const d = one<{ id: string }>(await pm(db).from('deposit_requests').select('id').eq('id', params.depositId!).maybeSingle(), 'deposit');
  if (!d) throw new HttpError(404, 'That deposit request was not found in this workspace.', 'NOT_FOUND');
  const eventId = await callRpc<string | null>(db, 'reemit_deposit_request', { p_deposit: d.id }, 'deposit');
  return { status: eventId ? 'EMITTED' : 'UNISSUED' };
});
