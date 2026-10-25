export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { DailyLogOpen } from '@/lib/commercial/schemas';
import { cmRpc } from '@/lib/commercial/server';

/**
 * POST /api/commercial/daily-logs — open the day's structured log for a job (one per job per
 * day; yesterday's manpower and equipment copy forward, CGC-70). Returns the existing one when open.
 */
export const POST = route({ access: { cap: 'projects.documents', action: 'create' }, mask: false, body: DailyLogOpen }, async ({ db, body }) => {
  return { id: await cmRpc<string>(db, 'cm_daily_log_open', { p_job: body.jobId, p_date: body.logDate, p_copy_forward: body.copyForward }) };
});
