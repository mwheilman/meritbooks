/**
 * Scheduler runner (INT-01 / IA M-12).
 *
 * One call = one tick. For every registered, implemented, enabled job it works out
 * which (job × org) units are DUE, then runs them oldest-slot-first under:
 *
 *   - single flight   core.scheduler_try_lock: a unit already locked by another
 *                     tick is skipped; an expired lock (a killed run) is reclaimed.
 *   - idempotency     one live job_runs row per '<job>:<org>:<slot>' (partial
 *                     unique index) — a slot can't run twice, a FAILED slot can retry.
 *   - timeouts        each run is raced against its job's timeoutMs; on timeout the
 *                     run is recorded failed and the lock is left to EXPIRE (the
 *                     abandoned promise may still be working — never double-run it).
 *   - budget          a unit only starts if the tick has room for its full timeout,
 *                     and at most `maxUnits` start per tick; the rest stay due and
 *                     are picked up by the next tick (every 5 min).
 *   - retry/backoff   a failed slot retries after 5, 10, 20… min (cap 60), up to the
 *                     job's maxAttempts, then the runner gives up on that slot.
 *   - kill switches   env SCHEDULER_PAUSED (everything), env SCHEDULER_DISABLED_JOBS
 *                     (per job), core.scheduled_jobs.enabled (platform row = every
 *                     tenant, org row = one tenant), registry `implemented=false`.
 *
 * A job error NEVER crashes the tick: every unit is fenced and its failure lands in
 * job_runs. The pure helpers (computeDue, resolveEffectiveConfig, backoffMs,
 * idempotencyKey) are exported for unit tests.
 */

import { latestSlotAtOrBefore, nextSlotAfter, parseCron, type CronSpec } from './cron';
import type {
  FinalRunStatus,
  JobContext,
  JobDefinition,
  JobResult,
  JobStatePatch,
  JobStateRow,
  SchedulerStore,
} from './types';

// ── pure helpers ─────────────────────────────────────────────────────────────

export const LOCK_MARGIN_MS = 60_000;
const BACKOFF_BASE_MS = 5 * 60_000;
const BACKOFF_CAP_MS = 60 * 60_000;
const MAX_ERROR_LEN = 2000;

export function stateKey(jobKey: string, orgId: string | null): string {
  return `${jobKey}|${orgId ?? '*'}`;
}

export function idempotencyKey(jobKey: string, orgId: string | null, slot: Date): string {
  return `${jobKey}:${orgId ?? 'platform'}:${slot.toISOString()}`;
}

/** Exponential backoff after the Nth failed attempt (1-based): 5, 10, 20, 40, 60, 60… min. */
export function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), BACKOFF_CAP_MS);
}

export interface EffectiveConfig {
  enabled: boolean;
  cron: string;
}

/**
 * Overrides resolve most-specific-first: the org row, then the platform row, then
 * the code registry. A platform job has only the platform row.
 */
export function resolveEffectiveConfig(
  def: JobDefinition,
  orgRow: JobStateRow | undefined,
  platformRow: JobStateRow | undefined,
): EffectiveConfig {
  const rows = def.scope === 'platform' ? [platformRow] : [orgRow, platformRow];
  let enabled: boolean | null = null;
  let cron: string | null = null;
  for (const r of rows) {
    if (!r) continue;
    if (enabled === null && r.enabled !== null && r.enabled !== undefined) enabled = r.enabled;
    if (cron === null && r.cron) cron = r.cron;
  }
  return { enabled: enabled ?? def.defaultEnabled, cron: cron ?? def.cron };
}

export type DueDecision =
  | { due: true; slot: Date; attempt: number }
  | { due: false; reason: 'no_slot' | 'done' | 'too_late' | 'backoff'; slot: Date | null };

/**
 * Is this unit due at `now`? The newest cron slot at/before now is due when it is
 * newer than the last finished slot, not older than the job's lateness window, and
 * not inside a failure backoff.
 */
export function computeDue(
  spec: CronSpec,
  now: Date,
  row: JobStateRow | undefined,
  def: Pick<JobDefinition, 'maxLatenessMinutes'>,
): DueDecision {
  const slot = latestSlotAtOrBefore(spec, now);
  if (!slot) return { due: false, reason: 'no_slot', slot: null };
  if (row?.last_slot_at && new Date(row.last_slot_at).getTime() >= slot.getTime()) {
    return { due: false, reason: 'done', slot };
  }
  if (now.getTime() - slot.getTime() > def.maxLatenessMinutes * 60_000) {
    return { due: false, reason: 'too_late', slot };
  }
  if (row?.backoff_until && new Date(row.backoff_until).getTime() > now.getTime()) {
    return { due: false, reason: 'backoff', slot };
  }
  const retrying = row?.pending_slot_at && new Date(row.pending_slot_at).getTime() === slot.getTime();
  const attempt = retrying ? (row?.attempts ?? 0) + 1 : 1;
  return { due: true, slot, attempt };
}

/** Env kill switches. */
export interface SchedulerEnv {
  paused: boolean;
  disabledJobs: ReadonlySet<string>;
}

export function readSchedulerEnv(env: NodeJS.ProcessEnv = process.env): SchedulerEnv {
  const paused = /^(1|true|yes|on)$/i.test((env.SCHEDULER_PAUSED ?? '').trim());
  const disabledJobs = new Set(
    (env.SCHEDULER_DISABLED_JOBS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return { paused, disabledJobs };
}

function truncate(s: string | null | undefined): string | null {
  if (!s) return null;
  return s.length > MAX_ERROR_LEN ? `${s.slice(0, MAX_ERROR_LEN)}…` : s;
}

// ── tick ─────────────────────────────────────────────────────────────────────

export type UnitOutcome =
  | 'ran'
  | 'locked' // another tick holds it
  | 'duplicate' // the slot already has a live/finished run
  | 'deferred' // out of tick budget / unit cap — next tick
  | 'error'; // the store itself failed (DB down) — logged, tick continues

export interface UnitReport {
  job: string;
  orgId: string | null;
  slot: string;
  attempt: number;
  outcome: UnitOutcome;
  status?: FinalRunStatus;
  durationMs?: number;
  error?: string;
}

export interface TickReport {
  tickId: string;
  startedAt: string;
  paused: boolean;
  due: number;
  started: number;
  units: UnitReport[];
  configErrors: Array<{ job: string; orgId: string | null; error: string }>;
}

export interface TickOptions {
  store: SchedulerStore;
  registry: readonly JobDefinition[];
  now: Date;
  tickId: string;
  /** Wall-clock budget for the whole tick. */
  budgetMs: number;
  /** Max units started per tick. */
  maxUnits: number;
  /** Units run in parallel. */
  concurrency: number;
  env: SchedulerEnv;
  /** Builds the per-unit context (clients). */
  makeContext: (args: { orgId: string | null; slotAt: Date; signal: AbortSignal; now: Date }) => JobContext;
  /** Monotonic-ish clock for budget/duration (tests inject). */
  clock?: () => number;
  log?: (event: Record<string, unknown>) => void;
}

interface DueUnit {
  def: JobDefinition;
  spec: CronSpec;
  orgId: string | null;
  slot: Date;
  attempt: number;
  /** consecutive_failures before this run (health signal; reset on success). */
  priorFailures: number;
}

class JobTimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${Math.round(ms / 1000)}s`);
    this.name = 'JobTimeoutError';
  }
}

async function runWithTimeout(
  fn: () => Promise<JobResult>,
  ms: number,
  controller: AbortController,
): Promise<JobResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new JobTimeoutError(ms));
    }, ms);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runTick(opts: TickOptions): Promise<TickReport> {
  const clock = opts.clock ?? (() => Date.now());
  const log = opts.log ?? ((e: Record<string, unknown>) => console.log(JSON.stringify(e)));
  const tickStart = clock();
  const deadline = tickStart + opts.budgetMs;
  const report: TickReport = {
    tickId: opts.tickId,
    startedAt: opts.now.toISOString(),
    paused: opts.env.paused,
    due: 0,
    started: 0,
    units: [],
    configErrors: [],
  };

  if (opts.env.paused) {
    log({ evt: 'scheduler.tick', tickId: opts.tickId, paused: true });
    return report;
  }

  const runnable = opts.registry.filter(
    (d) => d.implemented && typeof d.run === 'function' && !opts.env.disabledJobs.has(d.key),
  );
  if (runnable.length === 0) return report;

  const states = await opts.store.listStates(runnable.map((d) => d.key));
  const byKey = new Map<string, JobStateRow>(states.map((s) => [stateKey(s.job_key, s.org_id), s]));
  const orgs = runnable.some((d) => d.scope === 'org') ? await opts.store.listTargetOrgs() : [];

  // 1. Collect due units.
  const due: DueUnit[] = [];
  for (const def of runnable) {
    const platformRow = byKey.get(stateKey(def.key, null));
    const targets: Array<string | null> = def.scope === 'platform' ? [null] : orgs;
    for (const orgId of targets) {
      const row = orgId === null ? platformRow : byKey.get(stateKey(def.key, orgId));
      const cfg = resolveEffectiveConfig(def, orgId === null ? undefined : row, platformRow);
      if (!cfg.enabled) continue;
      let spec: CronSpec;
      try {
        spec = parseCron(cfg.cron);
      } catch (e) {
        report.configErrors.push({ job: def.key, orgId, error: e instanceof Error ? e.message : String(e) });
        continue;
      }
      const d = computeDue(spec, opts.now, row, def);
      if (d.due) {
        due.push({ def, spec, orgId, slot: d.slot, attempt: d.attempt, priorFailures: row?.consecutive_failures ?? 0 });
      }
    }
  }
  // Oldest slot first, so a backlog drains fairly across jobs and tenants.
  due.sort(
    (a, b) =>
      a.slot.getTime() - b.slot.getTime() ||
      a.def.key.localeCompare(b.def.key) ||
      (a.orgId ?? '').localeCompare(b.orgId ?? ''),
  );
  report.due = due.length;

  // 2. Run with a small concurrency pool, within budget + unit cap.
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < due.length) {
      const unit = due[cursor++];
      const base: UnitReport = {
        job: unit.def.key,
        orgId: unit.orgId,
        slot: unit.slot.toISOString(),
        attempt: unit.attempt,
        outcome: 'deferred',
      };
      if (report.started >= opts.maxUnits || deadline - clock() < unit.def.timeoutMs) {
        report.units.push(base);
        continue;
      }
      report.started++;
      report.units.push(await runUnit(unit, base, opts, clock, log));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, () => worker()));

  log({
    evt: 'scheduler.tick',
    tickId: opts.tickId,
    due: report.due,
    started: report.started,
    deferred: report.units.filter((u) => u.outcome === 'deferred').length,
    failed: report.units.filter((u) => u.status === 'failed' || u.outcome === 'error').length,
    configErrors: report.configErrors.length,
    ms: clock() - tickStart,
  });
  return report;
}

async function runUnit(
  unit: DueUnit,
  base: UnitReport,
  opts: TickOptions,
  clock: () => number,
  log: (event: Record<string, unknown>) => void,
): Promise<UnitReport> {
  const { def, orgId, slot, attempt } = unit;
  const owner = `${opts.tickId}:${def.key}:${orgId ?? 'platform'}`;
  const ttlSeconds = Math.ceil((def.timeoutMs + LOCK_MARGIN_MS) / 1000);

  let locked = false;
  let patch: JobStatePatch = {};
  let clearLock = true;
  try {
    locked = await opts.store.tryLock(def.key, orgId, owner, ttlSeconds);
    if (!locked) return { ...base, outcome: 'locked' };

    await opts.store.abandonStaleRuns(def.key, orgId);

    const run = await opts.store.startRun({
      jobKey: def.key,
      orgId,
      slotAt: slot.toISOString(),
      attempt,
      idempotencyKey: idempotencyKey(def.key, orgId, slot),
      trigger: 'cron',
    });
    if (!run) {
      // The slot already ran (state write lost) — just mark it finished.
      patch = { last_slot_at: slot.toISOString(), pending_slot_at: null, attempts: 0, backoff_until: null };
      return { ...base, outcome: 'duplicate' };
    }

    const controller = new AbortController();
    const started = clock();
    let result: JobResult;
    let timedOut = false;
    try {
      const ctx = opts.makeContext({ orgId, slotAt: slot, signal: controller.signal, now: opts.now });
      const runFn = def.run as (c: JobContext) => Promise<JobResult>;
      result = await runWithTimeout(() => runFn(ctx), def.timeoutMs, controller);
    } catch (e) {
      timedOut = e instanceof JobTimeoutError;
      result = { status: 'failed', error: e instanceof Error ? e.message : String(e) };
    }
    const durationMs = clock() - started;
    const finishedAt = new Date(opts.now.getTime() + durationMs).toISOString();

    await opts.store.finishRun(run.id, {
      status: result.status,
      finishedAt,
      durationMs,
      itemsProcessed: Math.max(0, Math.trunc(result.itemsProcessed ?? 0)),
      counts: result.counts ?? {},
      summary: truncate(result.summary),
      error: truncate(result.error),
    });

    const next = nextSlotAfter(unit.spec, opts.now);
    if (result.status === 'failed') {
      const gaveUp = attempt >= def.maxAttempts;
      patch = {
        last_run_at: finishedAt,
        last_status: 'failed',
        consecutive_failures: unit.priorFailures + 1,
        next_run_at: next?.toISOString() ?? null,
        ...(gaveUp
          ? { last_slot_at: slot.toISOString(), pending_slot_at: null, attempts: 0, backoff_until: null }
          : {
              pending_slot_at: slot.toISOString(),
              attempts: attempt,
              backoff_until: new Date(opts.now.getTime() + backoffMs(attempt)).toISOString(),
            }),
      };
      // Timed out: the abandoned promise may still be running — let the lock expire.
      if (timedOut) clearLock = false;
    } else {
      patch = {
        last_run_at: finishedAt,
        last_status: result.status,
        last_slot_at: slot.toISOString(),
        pending_slot_at: null,
        attempts: 0,
        consecutive_failures: 0,
        backoff_until: null,
        next_run_at: next?.toISOString() ?? null,
      };
    }

    log({
      evt: 'scheduler.run',
      tickId: opts.tickId,
      job: def.key,
      orgId,
      slot: slot.toISOString(),
      attempt,
      status: result.status,
      items: result.itemsProcessed ?? 0,
      ms: durationMs,
      error: result.error ? truncate(result.error) : undefined,
    });
    return { ...base, outcome: 'ran', status: result.status, durationMs, error: result.error };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log({ evt: 'scheduler.unit_error', tickId: opts.tickId, job: def.key, orgId, error: msg });
    return { ...base, outcome: 'error', error: msg };
  } finally {
    if (locked) {
      try {
        await opts.store.release(def.key, orgId, owner, patch, { clearLock });
      } catch (e) {
        log({
          evt: 'scheduler.release_error',
          tickId: opts.tickId,
          job: def.key,
          orgId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
}
