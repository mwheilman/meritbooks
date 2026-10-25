export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { HttpError, PmQueryError, type PgErrorLike } from '@/lib/api-errors';
import { laborErrorCopy } from '@/lib/pm/labor/errors';
import { AckLateTimeBody } from '@/lib/pm/labor/schemas';

function laborError(e: PgErrorLike): Error {
  const c = laborErrorCopy(e);
  return c ? new HttpError(c.status, c.error, c.code) : new PmQueryError('acknowledge late time', e);
}

/**
 * POST /api/ops/time/ack — acknowledge late phone / kiosk time one entry at a time, ahead of
 * approval (pm.dlr_ack_late_time, 1125): the approver has looked at each entry the phone sent late.
 * Someone other than the worker; the entry must be a late tap that is not approved or void. The
 * normal approval (chain included) can then approve it. Hours only, no money.
 */
export const POST = route({ access: { cap: 'projects.time', action: 'approve' }, mask: false, body: AckLateTimeBody }, async ({ db, body }) => {
  const r = await db.schema('pm').rpc('dlr_ack_late_time', { p_ids: [...new Set(body.ids)] });
  if (r.error) throw laborError(r.error);
  return { acknowledged: Number((r.data as { acknowledged?: number } | null)?.acknowledged ?? 0) };
});
