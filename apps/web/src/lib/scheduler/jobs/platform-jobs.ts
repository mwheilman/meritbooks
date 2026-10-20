/**
 * Platform-scope housekeeping jobs (no tenant; service role only).
 *
 *   scheduler.prune_runs  delete core.job_runs rows older than the retention window
 *                         so the hourly drains don't grow the run log forever.
 */

import type { JobContext, JobResult } from '../types';

export const JOB_RUN_RETENTION_DAYS = 90;

export async function runPruneRunsJob(ctx: JobContext): Promise<JobResult> {
  const cutoff = new Date(ctx.now.getTime() - JOB_RUN_RETENTION_DAYS * 86_400_000).toISOString();
  const { count, error } = await ctx.admin
    .schema('core')
    .from('job_runs')
    .delete({ count: 'exact' })
    .lt('started_at', cutoff)
    .neq('status', 'running');
  if (error) return { status: 'failed', error: error.message };
  return {
    status: 'ok',
    itemsProcessed: count ?? 0,
    counts: { deleted: count ?? 0, retention_days: JOB_RUN_RETENTION_DAYS },
    summary: `Pruned ${count ?? 0} run-log row(s) older than ${JOB_RUN_RETENTION_DAYS} days.`,
  };
}
