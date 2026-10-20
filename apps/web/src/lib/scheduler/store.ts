/**
 * Supabase-backed SchedulerStore (service role). The scheduler's ONLY writer of
 * core.scheduled_jobs / core.job_runs — members are SELECT-only on both
 * (migration 162). Every method fails loudly (throws) on a DB error so the runner
 * records the unit as `error` instead of silently pretending it ran.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  FinishRunInput,
  JobStatePatch,
  JobStateRow,
  SchedulerStore,
  StartRunInput,
} from './types';

const STATE_COLUMNS =
  'job_key, org_id, enabled, cron, last_slot_at, pending_slot_at, attempts, consecutive_failures, backoff_until, lock_owner, lock_expires_at';

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = '23505';

export class SupabaseSchedulerStore implements SchedulerStore {
  constructor(private readonly admin: SupabaseClient) {}

  private jobs() {
    return this.admin.schema('core').from('scheduled_jobs');
  }

  private runs() {
    return this.admin.schema('core').from('job_runs');
  }

  async listStates(jobKeys: readonly string[]): Promise<JobStateRow[]> {
    if (jobKeys.length === 0) return [];
    const { data, error } = await this.jobs()
      .select(STATE_COLUMNS)
      .in('job_key', [...jobKeys])
      .is('location_id', null);
    if (error) throw new Error(`scheduler: listStates failed: ${error.message}`);
    return (data ?? []) as JobStateRow[];
  }

  async listTargetOrgs(): Promise<string[]> {
    // Suspended / churned tenants get no background work (no emails, no proposals).
    const { data, error } = await this.admin
      .schema('core')
      .from('organizations')
      .select('id')
      .not('lifecycle_status', 'in', '(suspended,churned)')
      .order('id');
    if (error) throw new Error(`scheduler: listTargetOrgs failed: ${error.message}`);
    return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  }

  async tryLock(jobKey: string, orgId: string | null, owner: string, ttlSeconds: number): Promise<boolean> {
    const { data, error } = await this.admin.schema('core').rpc('scheduler_try_lock', {
      p_job_key: jobKey,
      p_org_id: orgId,
      p_owner: owner,
      p_ttl_seconds: ttlSeconds,
    });
    if (error) throw new Error(`scheduler: tryLock failed: ${error.message}`);
    return data === true;
  }

  async abandonStaleRuns(jobKey: string, orgId: string | null): Promise<number> {
    let q = this.runs()
      .update(
        { status: 'failed', error: 'abandoned: the previous run never finished (lock expired)', finished_at: new Date().toISOString() },
        { count: 'exact' },
      )
      .eq('job_key', jobKey)
      .eq('status', 'running');
    q = orgId === null ? q.is('org_id', null) : q.eq('org_id', orgId);
    const { count, error } = await q;
    if (error) throw new Error(`scheduler: abandonStaleRuns failed: ${error.message}`);
    return count ?? 0;
  }

  async startRun(input: StartRunInput): Promise<{ id: string } | null> {
    const { data, error } = await this.runs()
      .insert({
        job_key: input.jobKey,
        org_id: input.orgId,
        slot_at: input.slotAt,
        attempt: input.attempt,
        idempotency_key: input.idempotencyKey,
        trigger: input.trigger,
        actor: 'system:scheduler',
        status: 'running',
      })
      .select('id')
      .single();
    if (error) {
      if (error.code === UNIQUE_VIOLATION) return null;
      throw new Error(`scheduler: startRun failed: ${error.message}`);
    }
    return { id: (data as { id: string }).id };
  }

  async finishRun(runId: string, input: FinishRunInput): Promise<void> {
    const { error } = await this.runs()
      .update({
        status: input.status,
        finished_at: input.finishedAt,
        duration_ms: input.durationMs,
        items_processed: input.itemsProcessed,
        counts: input.counts,
        summary: input.summary,
        error: input.error,
      })
      .eq('id', runId);
    if (error) throw new Error(`scheduler: finishRun failed: ${error.message}`);
  }

  async release(
    jobKey: string,
    orgId: string | null,
    owner: string,
    patch: JobStatePatch,
    opts: { clearLock: boolean },
  ): Promise<void> {
    const update: Record<string, unknown> = { ...patch, updated_at: new Date().toISOString() };
    if (opts.clearLock) {
      update.lock_owner = null;
      update.lock_expires_at = null;
    }
    let q = this.jobs().update(update).eq('job_key', jobKey).eq('lock_owner', owner).is('location_id', null);
    q = orgId === null ? q.is('org_id', null) : q.eq('org_id', orgId);
    const { error } = await q;
    if (error) throw new Error(`scheduler: release failed: ${error.message}`);
  }
}
