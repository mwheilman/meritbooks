/**
 * Scheduler (INT-01 / IA M-12) — shared types.
 *
 * The scheduler is ONE Vercel Cron tick (/api/cron/tick, every 5 min) that asks the
 * code registry which (job, org) units are DUE, claims each with a single-flight DB
 * lock, runs it under a timeout, and records a row in core.job_runs. Nothing here
 * talks to Next.js — the runner is pure orchestration over a `SchedulerStore`, so it
 * is unit-testable with an in-memory store.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type RunStatus = 'running' | 'ok' | 'partial' | 'failed' | 'skipped';
export type FinalRunStatus = Exclude<RunStatus, 'running'>;

/** `org` = fanned out once per tenant; `platform` = one run, no tenant. */
export type JobScope = 'org' | 'platform';

export type CountValue = number | string | boolean | null;

/** What a job hands back to the runner. */
export interface JobResult {
  /**
   * ok       did its work (including "proposed only — awaiting a human").
   * partial  some sub-steps failed; the rest succeeded.
   * skipped  nothing to do / precondition not met (e.g. JWT secret missing).
   * failed   the job could not do its work. The runner retries with backoff.
   */
  status: FinalRunStatus;
  itemsProcessed?: number;
  counts?: Record<string, CountValue>;
  /** One plain-English line for the Automation-health widget. */
  summary?: string;
  error?: string;
}

/** Everything a job needs, already scoped to ONE unit (job × org). */
export interface JobContext {
  /** The tenant this unit runs for; null for platform jobs. */
  orgId: string | null;
  /** Tick clock (tests inject a fixed time). */
  now: Date;
  /** The cron occurrence this run serves. */
  slotAt: Date;
  /** Aborted when the job exceeds its timeout — long loops should check it. */
  signal: AbortSignal;
  /**
   * Service-role client. ONLY for scheduler bookkeeping, metadata discovery
   * (names/cadences), and engines that already scope every read+write to an
   * explicit org (the event drains). Never hand it to an engine that relies on RLS.
   */
  admin: SupabaseClient;
  /**
   * An RLS-scoped client for `orgId` (self-signed org JWT, see
   * lib/reports/compiler/org-scoped-client.ts), or null when it can't be minted
   * (SUPABASE_JWT_SECRET missing, or a platform job). Jobs MUST fail closed
   * (skip) on null — never substitute the admin client for tenant reads.
   */
  scopedClient: () => SupabaseClient | null;
}

export interface JobDefinition {
  /** Stable key, e.g. `controls.nightly`. Matches IA §6 where the IA names one. */
  key: string;
  label: string;
  description: string;
  scope: JobScope;
  /** Default 5-field UTC cron. A core.scheduled_jobs row may override it. */
  cron: string;
  /** Default on/off. A scheduled_jobs row (org, then platform) may override it. */
  defaultEnabled: boolean;
  /** false = registered stub for a future job; it NEVER runs, whatever the DB says. */
  implemented: boolean;
  /** Capability whose widgets show this job's done-state (IA M-12 owner_capability). */
  ownerCapability: string;
  /** Module that owns the implementation (the TODO owner for stubs). */
  owner: string;
  /** True when the job can post to the GL — then it MUST consult the autonomy dial. */
  postsToGl: boolean;
  /** Autonomy feature key gating GL posting (lib/autonomy/catalog.ts). */
  autonomyFeature?: string;
  /** Hard per-run timeout. The lock TTL is this + a margin. */
  timeoutMs: number;
  /** A slot older than this is not run (we wait for the next one). */
  maxLatenessMinutes: number;
  /** Attempts per slot before the runner gives up on it. */
  maxAttempts: number;
  /** For stubs: what has to exist before this can be implemented. */
  todo?: string;
  run?: (ctx: JobContext) => Promise<JobResult>;
}

/** core.scheduled_jobs row as the runner needs it (location_id IS NULL rows only). */
export interface JobStateRow {
  job_key: string;
  org_id: string | null;
  enabled: boolean | null;
  cron: string | null;
  last_slot_at: string | null;
  pending_slot_at: string | null;
  attempts: number;
  consecutive_failures: number;
  backoff_until: string | null;
  lock_owner: string | null;
  lock_expires_at: string | null;
}

/** Mutable run-state columns the runner writes back when it releases a unit. */
export interface JobStatePatch {
  last_slot_at?: string | null;
  pending_slot_at?: string | null;
  attempts?: number;
  consecutive_failures?: number;
  backoff_until?: string | null;
  last_run_at?: string;
  last_status?: FinalRunStatus;
  next_run_at?: string | null;
}

export interface StartRunInput {
  jobKey: string;
  orgId: string | null;
  slotAt: string;
  attempt: number;
  idempotencyKey: string;
  trigger: 'cron' | 'manual';
}

export interface FinishRunInput {
  status: FinalRunStatus;
  finishedAt: string;
  durationMs: number;
  itemsProcessed: number;
  counts: Record<string, CountValue>;
  summary: string | null;
  error: string | null;
}

/** Persistence seam. Production = Supabase service role; tests = in-memory. */
export interface SchedulerStore {
  listStates(jobKeys: readonly string[]): Promise<JobStateRow[]>;
  /** Tenants that org-scoped jobs fan out over. */
  listTargetOrgs(): Promise<string[]>;
  /** Atomic single-flight claim. true = this owner holds the lock now. */
  tryLock(jobKey: string, orgId: string | null, owner: string, ttlSeconds: number): Promise<boolean>;
  /** Mark 'running' rows left by a dead holder as failed. Call only while holding the lock. */
  abandonStaleRuns(jobKey: string, orgId: string | null): Promise<number>;
  /** Insert a running row. null = the idempotency key is already live (running/finished). */
  startRun(input: StartRunInput): Promise<{ id: string } | null>;
  finishRun(runId: string, input: FinishRunInput): Promise<void>;
  /** Write run state and (optionally) clear the lock — only if `owner` still holds it. */
  release(
    jobKey: string,
    orgId: string | null,
    owner: string,
    patch: JobStatePatch,
    opts: { clearLock: boolean },
  ): Promise<void>;
}
