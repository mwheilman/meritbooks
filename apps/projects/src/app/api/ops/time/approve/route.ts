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
 * rate) stops the batch; your own time is sent on to someone else.
 */
export const POST = route({ access: { cap: 'projects.time', action: 'approve' }, mask: false, body: ApproveTimeBody }, async ({ db, body }) => {
  const r = await approveTimeEntries(db, body.ids, laborError);
  return { approved: r.approved, pending: r.pending, sentOn: r.sentOn, results: r.results };
});
