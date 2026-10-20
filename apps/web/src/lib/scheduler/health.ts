/**
 * Read model for the future "Automation health" widget (IA M-12: every widget whose
 * done-state depends on a job reads its last run). Pure assembly + validation; the
 * route does the I/O.
 */

import { z } from 'zod';
import { getJob, listJobSummaries, type JobSummary } from './registry';
import { readSchedulerEnv, resolveEffectiveConfig } from './run';
import type { CountValue, JobStateRow, RunStatus } from './types';

export const runsQuerySchema = z
  .object({
    job_key: z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_:-]+)+$/).optional(),
    status: z.enum(['running', 'ok', 'partial', 'failed', 'skipped']).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional().default(50),
    before: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export type RunsQuery = z.infer<typeof runsQuerySchema>;

export interface JobRunView {
  id: string;
  job_key: string;
  slot_at: string;
  attempt: number;
  trigger: string;
  actor: string;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  items_processed: number;
  counts: Record<string, CountValue>;
  summary: string | null;
  error: string | null;
}

export interface ScheduledJobStateView extends JobStateRow {
  last_run_at: string | null;
  last_status: RunStatus | null;
  next_run_at: string | null;
}

export interface JobHealthView extends JobSummary {
  /** Effective for THIS tenant (registry → platform override → org override → env). */
  enabled: boolean;
  effectiveCron: string;
  state: 'running_normally' | 'failing' | 'disabled' | 'not_built' | 'never_run';
  lastRunAt: string | null;
  lastStatus: RunStatus | null;
  nextRunAt: string | null;
  consecutiveFailures: number;
}

export function buildJobHealth(
  orgId: string,
  states: readonly ScheduledJobStateView[],
  env = readSchedulerEnv(),
): JobHealthView[] {
  const orgRows = new Map(states.filter((s) => s.org_id === orgId).map((s) => [s.job_key, s]));
  const platformRows = new Map(states.filter((s) => s.org_id === null).map((s) => [s.job_key, s]));
  return listJobSummaries().map((summary) => {
    const def = getJob(summary.key);
    const orgRow = orgRows.get(summary.key);
    const platformRow = platformRows.get(summary.key);
    const ownRow = summary.scope === 'platform' ? platformRow : orgRow;
    const cfg = def
      ? resolveEffectiveConfig(def, orgRow, platformRow)
      : { enabled: false, cron: summary.cron };
    const enabled =
      summary.implemented && cfg.enabled && !env.paused && !env.disabledJobs.has(summary.key);
    const failures = ownRow?.consecutive_failures ?? 0;
    let state: JobHealthView['state'];
    if (!summary.implemented) state = 'not_built';
    else if (!enabled) state = 'disabled';
    else if (!ownRow?.last_run_at) state = 'never_run';
    else if (failures > 0 || ownRow.last_status === 'failed') state = 'failing';
    else state = 'running_normally';
    return {
      ...summary,
      enabled,
      effectiveCron: cfg.cron,
      state,
      lastRunAt: ownRow?.last_run_at ?? null,
      lastStatus: ownRow?.last_status ?? null,
      nextRunAt: enabled ? ownRow?.next_run_at ?? null : null,
      consecutiveFailures: failures,
    };
  });
}
