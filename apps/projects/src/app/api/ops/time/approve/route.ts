export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { laborCall } from '@/lib/pm/labor/rpc';
import { ApproveTimeBody } from '@/lib/pm/labor/schemas';

/**
 * Approve submitted time in bulk (pm.approve_time_entries, 1108). Pins the cost rate at
 * pay + burden × the pay-type factor (never overhead) and the card's bill rate, and sends a
 * JOB_TIME per entry to Merit Books when the seam supports it. All or nothing: one entry that
 * cannot be approved (your own, not submitted, no pay rate) stops the batch.
 */
export const POST = route({ body: ApproveTimeBody }, async ({ db, body }) => {
  const n = await laborCall<number>(db, 'approve_time_entries', { p_ids: body.ids });
  return { approved: n ?? 0 };
});
