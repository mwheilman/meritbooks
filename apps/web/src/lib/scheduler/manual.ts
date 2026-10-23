/**
 * "Run now" and the per-tenant on/off switch for the Automation screen (Settings →
 * Automation). Both are tenant-scoped: a person can only ever run or toggle a job for
 * THEIR org, and only org-scoped, implemented jobs.
 *
 * RUN NOW takes the same single-flight lock the cron tick uses (so it can never overlap a
 * scheduled run of the same job for the tenant), records a `trigger: 'manual'` row in
 * core.job_runs with the person as actor, and runs the job under its normal timeout with
 * the tenant's RLS-scoped client. It does NOT touch the cron bookkeeping (last slot,
 * attempts, backoff) — the next scheduled slot still runs as planned. The job itself is
 * the same code the cron runs, so every guard (autonomy dial, period locks, idempotency
 * per period) applies unchanged.
 *
 * THE SWITCH writes the tenant row's `enabled` override in core.scheduled_jobs (NULL =
 * back to the default). Service role, org pinned; the route checked settings_system:edit.
 */

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createOrgScopedSupabase } from '@/lib/reports/compiler/org-scoped-client';
import { getJob } from './registry';
import { LOCK_MARGIN_MS, readSchedulerEnv, type SchedulerEnv } from './run';
import { SupabaseSchedulerStore } from './store';
import type { JobContext, JobDefinition, JobResult, SchedulerStore } from './types';

export class ManualRunError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ManualRunError';
  }
}

export function assertRunnableForTenant(jobKey: string): JobDefinition {
  const def = getJob(jobKey);
  if (!def) throw new ManualRunError('Unknown job.', 404);
  if (!def.implemented || typeof def.run !== 'function') throw new ManualRunError(`${def.label} isn't built yet, so it can't run.`, 409);
  if (def.scope !== 'org') throw new ManualRunError(`${def.label} runs for the whole platform and can't be started from a tenant.`, 403);
  return def;
}

export interface ManualRunOutcome {
  runId: string;
  status: JobResult['status'];
  summary: string | null;
  error: string | null;
  itemsProcessed: number;
  durationMs: number;
}

export interface ManualRunDeps {
  admin: SupabaseClient;
  store?: SchedulerStore;
  /** Tests inject; production mints the per-tenant RLS client. */
  scopedClient?: () => SupabaseClient | null;
  now?: () => Date;
  /** Tests inject; production reads SCHEDULER_PAUSED / SCHEDULER_DISABLED_JOBS. */
  env?: SchedulerEnv;
}

/**
 * The operator kill switches the cron tick honours (run.ts) apply to "Run now" too — a
 * paused scheduler, a job disabled by env, or a job turned off on the PLATFORM row
 * (org_id null, enabled = false) can't be started from a tenant. A tenant's own off
 * switch does not block their explicit Run now (that is their choice to make).
 */
export async function assertNotKilled(def: JobDefinition, store: SchedulerStore, env: SchedulerEnv): Promise<void> {
  if (env.paused) {
    throw new ManualRunError('Automation is paused for maintenance by the platform operator, so jobs can’t run right now. Try again later.', 503);
  }
  if (env.disabledJobs.has(def.key)) {
    throw new ManualRunError(`${def.label} has been switched off by the platform operator, so it can’t run right now.`, 409);
  }
  const states = await store.listStates([def.key]);
  const platformRow = states.find((s) => s.job_key === def.key && s.org_id === null);
  if (platformRow?.enabled === false) {
    throw new ManualRunError(`${def.label} has been turned off for every company by the platform operator, so it can’t run right now.`, 409);
  }
}

export async function runJobNow(deps: ManualRunDeps, jobKey: string, orgId: string, actor: string): Promise<ManualRunOutcome> {
  const def = assertRunnableForTenant(jobKey);
  const store = deps.store ?? new SupabaseSchedulerStore(deps.admin);
  await assertNotKilled(def, store, deps.env ?? readSchedulerEnv());
  const now = deps.now?.() ?? new Date();
  const owner = `manual:${randomUUID()}`;
  const ttl = Math.ceil((def.timeoutMs + LOCK_MARGIN_MS) / 1000);

  const locked = await store.tryLock(def.key, orgId, owner, ttl);
  if (!locked) throw new ManualRunError(`${def.label} is running right now — wait for it to finish.`, 409);

  let clearLock = true;
  try {
    await store.abandonStaleRuns(def.key, orgId);
    const run = await store.startRun({
      jobKey: def.key,
      orgId,
      slotAt: now.toISOString(),
      attempt: 1,
      idempotencyKey: `${def.key}:${orgId}:manual:${now.toISOString()}:${owner.slice(-8)}`,
      trigger: 'manual',
      actor: actor.slice(0, 200),
    });
    if (!run) throw new ManualRunError('That run was already started.', 409);

    const controller = new AbortController();
    let scoped: SupabaseClient | null | undefined;
    const ctx: JobContext = {
      orgId,
      now,
      slotAt: now,
      signal: controller.signal,
      admin: deps.admin,
      scopedClient: () => {
        if (scoped === undefined) scoped = deps.scopedClient ? deps.scopedClient() : createOrgScopedSupabase(orgId);
        return scoped;
      },
    };

    const started = Date.now();
    let result: JobResult;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const runFn = def.run as (c: JobContext) => Promise<JobResult>;
      result = await Promise.race([
        runFn(ctx),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            clearLock = false; // the abandoned promise may still be working — let the lock expire
            reject(new Error(`timed out after ${Math.round(def.timeoutMs / 1000)}s`));
          }, def.timeoutMs);
        }),
      ]);
    } catch (e) {
      result = { status: 'failed', error: e instanceof Error ? e.message : String(e) };
    } finally {
      if (timer) clearTimeout(timer);
    }
    const durationMs = Date.now() - started;
    const finishedAt = new Date(now.getTime() + durationMs).toISOString();
    const summary = result.summary ? result.summary.slice(0, 2000) : null;
    const error = result.error ? result.error.slice(0, 2000) : null;
    await store.finishRun(run.id, {
      status: result.status,
      finishedAt,
      durationMs,
      itemsProcessed: Math.max(0, Math.trunc(result.itemsProcessed ?? 0)),
      counts: result.counts ?? {},
      summary,
      error,
    });
    // Health only (last run / status) — the cron slot bookkeeping is untouched.
    await store.release(def.key, orgId, owner, { last_run_at: finishedAt, last_status: result.status }, { clearLock });
    return { runId: run.id, status: result.status, summary, error, itemsProcessed: Math.max(0, Math.trunc(result.itemsProcessed ?? 0)), durationMs };
  } catch (e) {
    // Release the lock on any failure before the job ran (never leave it wedged).
    await store.release(def.key, orgId, owner, {}, { clearLock: true }).catch(() => undefined);
    throw e;
  }
}

/** Set (true / false) or clear (null = default) the tenant's on/off override for a job. */
export async function setTenantJobEnabled(admin: SupabaseClient, jobKey: string, orgId: string, enabled: boolean | null): Promise<void> {
  assertRunnableForTenant(jobKey);
  const jobs = admin.schema('core').from('scheduled_jobs');
  const { data: existing, error: readErr } = await jobs
    .select('id')
    .eq('job_key', jobKey)
    .eq('org_id', orgId)
    .is('location_id', null)
    .maybeSingle();
  if (readErr) throw new ManualRunError(`Could not read the job setting: ${readErr.message}`, 500);
  if (existing) {
    const { error } = await admin
      .schema('core')
      .from('scheduled_jobs')
      .update({ enabled, updated_at: new Date().toISOString() })
      .eq('id', (existing as { id: string }).id)
      .eq('org_id', orgId);
    if (error) throw new ManualRunError(`Could not save the job setting: ${error.message}`, 500);
    return;
  }
  const { error } = await admin.schema('core').from('scheduled_jobs').insert({ job_key: jobKey, org_id: orgId, location_id: null, enabled });
  if (error) throw new ManualRunError(`Could not save the job setting: ${error.message}`, 500);
}
