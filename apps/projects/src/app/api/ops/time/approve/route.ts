export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { HttpError, PmQueryError, type PgErrorLike } from '@/lib/api-errors';
import { approveTimeEntries } from '@/lib/approvals/server';
import { laborErrorCopy } from '@/lib/pm/labor/errors';
import { ApproveTimeBody } from '@/lib/pm/labor/schemas';

function laborError(e: PgErrorLike): Error {
  const c = laborErrorCopy(e);
  return c ? new HttpError(c.status, c.error, c.code) : new PmQueryError('approve time', e);
}

/**
 * Approve submitted time in bulk — through the approvals engine (1113): each entry's chain
 * (PM, or foreman then PM, by company size) records this approver's step; at the last step the entry
 * is approved by pm.approve_time_entries (1108), which pins the cost rate at pay + burden × the
 * pay-type factor (never overhead) and the card's bill rate, and sends a JOB_TIME per entry to
 * Merit Books when the seam supports it. An entry that cannot be approved (not submitted, no pay
 * rate) stops the batch; your own time is sent on to someone else. A late phone / kiosk tap (1125)
 * must be acknowledged first, one by one (ackLate, or POST /api/ops/time/ack).
 */
export const POST = route({ access: { cap: 'projects.time', action: 'approve' }, mask: false, body: ApproveTimeBody }, async ({ db, body }) => {
  // Late phone / kiosk taps (1125) are approved only after the approver acknowledged each one:
  // refuse the batch up front (nothing half-approved), or acknowledge the ones named in ackLate.
  const late = await db.schema('pm').from('v_time_entries_masked').select('id, late_tap, late_ack_at').in('id', body.ids).eq('late_tap', true).is('late_ack_at', null);
  if (late.error) throw new PmQueryError('check late time', late.error);
  const ack = new Set(body.ackLate);
  const unacked = ((late.data ?? []) as Array<{ id: string }>).filter((t) => !ack.has(t.id));
  if (unacked.length) {
    throw new HttpError(422, `${unacked.length === 1 ? 'One entry was' : `${unacked.length} entries were`} entered late from the phone. Acknowledge each one on the time sheet, then approve.`, 'PM_LATE_TAP');
  }
  const toAck = ((late.data ?? []) as Array<{ id: string }>).map((t) => t.id);
  if (toAck.length) {
    const a = await db.schema('pm').rpc('dlr_ack_late_time', { p_ids: toAck });
    if (a.error) throw laborError(a.error);
  }
  const r = await approveTimeEntries(db, body.ids, laborError);
  return { approved: r.approved, pending: r.pending, sentOn: r.sentOn, results: r.results };
});
