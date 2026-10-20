/**
 * Scheduler runner — due computation, single-flight locking, idempotency, kill
 * switches, error isolation, timeouts, retry/backoff, budget. Runs against an
 * in-memory SchedulerStore that mirrors migration 162's semantics (expiring lock,
 * idempotency key unique among non-failed runs, owner-only release).
 */

import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { parseCron } from './cron';
import {
  backoffMs,
  computeDue,
  idempotencyKey,
  resolveEffectiveConfig,
  runTick,
  stateKey,
  type SchedulerEnv,
  type TickOptions,
} from './run';
import type {
  FinishRunInput,
  JobContext,
  JobDefinition,
  JobResult,
  JobStatePatch,
  JobStateRow,
  RunStatus,
  SchedulerStore,
  StartRunInput,
} from './types';

// ── in-memory store ──────────────────────────────────────────────────────────

interface MemRun extends StartRunInput {
  id: string;
  status: RunStatus;
  finish?: FinishRunInput;
}

class MemoryStore implements SchedulerStore {
  states = new Map<string, JobStateRow>();
  runs: MemRun[] = [];
  private seq = 0;
  constructor(
    public orgs: string[],
    public nowMs: () => number,
  ) {}

  private row(jobKey: string, orgId: string | null): JobStateRow {
    const k = stateKey(jobKey, orgId);
    let r = this.states.get(k);
    if (!r) {
      r = {
        job_key: jobKey,
        org_id: orgId,
        enabled: null,
        cron: null,
        last_slot_at: null,
        pending_slot_at: null,
        attempts: 0,
        consecutive_failures: 0,
        backoff_until: null,
        lock_owner: null,
        lock_expires_at: null,
      };
      this.states.set(k, r);
    }
    return r;
  }

  seed(jobKey: string, orgId: string | null, patch: Partial<JobStateRow>): void {
    Object.assign(this.row(jobKey, orgId), patch);
  }

  get(jobKey: string, orgId: string | null): JobStateRow | undefined {
    return this.states.get(stateKey(jobKey, orgId));
  }

  async listStates(jobKeys: readonly string[]): Promise<JobStateRow[]> {
    return [...this.states.values()].filter((s) => jobKeys.includes(s.job_key)).map((s) => ({ ...s }));
  }
  async listTargetOrgs(): Promise<string[]> {
    return [...this.orgs];
  }
  async tryLock(jobKey: string, orgId: string | null, owner: string, ttlSeconds: number): Promise<boolean> {
    const r = this.row(jobKey, orgId);
    const now = this.nowMs();
    if (r.lock_owner && r.lock_expires_at && new Date(r.lock_expires_at).getTime() > now) return false;
    r.lock_owner = owner;
    r.lock_expires_at = new Date(now + ttlSeconds * 1000).toISOString();
    return true;
  }
  async abandonStaleRuns(jobKey: string, orgId: string | null): Promise<number> {
    let n = 0;
    for (const r of this.runs) {
      if (r.jobKey === jobKey && r.orgId === orgId && r.status === 'running') {
        r.status = 'failed';
        n++;
      }
    }
    return n;
  }
  async startRun(input: StartRunInput): Promise<{ id: string } | null> {
    if (this.runs.some((r) => r.idempotencyKey === input.idempotencyKey && r.status !== 'failed')) return null;
    const id = `run-${++this.seq}`;
    this.runs.push({ ...input, id, status: 'running' });
    return { id };
  }
  async finishRun(runId: string, input: FinishRunInput): Promise<void> {
    const r = this.runs.find((x) => x.id === runId);
    if (r) {
      r.status = input.status;
      r.finish = input;
    }
  }
  async release(
    jobKey: string,
    orgId: string | null,
    owner: string,
    patch: JobStatePatch,
    opts: { clearLock: boolean },
  ): Promise<void> {
    const r = this.row(jobKey, orgId);
    if (r.lock_owner !== owner) return;
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined && k in r) (r as unknown as Record<string, unknown>)[k] = v;
    }
    if (opts.clearLock) {
      r.lock_owner = null;
      r.lock_expires_at = null;
    }
  }
}

// ── fixtures ─────────────────────────────────────────────────────────────────

const ORG_A = 'org-a';
const ORG_B = 'org-b';
const NOW = new Date('2026-10-20T08:12:00Z'); // 2 min after a 08:10 daily slot
const NO_ENV: SchedulerEnv = { paused: false, disabledJobs: new Set() };

function job(key: string, run: (ctx: JobContext) => Promise<JobResult>, over: Partial<JobDefinition> = {}): JobDefinition {
  return {
    key,
    label: key,
    description: key,
    scope: 'org',
    cron: '10 8 * * *',
    defaultEnabled: true,
    implemented: true,
    ownerCapability: 'test',
    owner: 'test',
    postsToGl: false,
    timeoutMs: 5_000,
    maxLatenessMinutes: 60,
    maxAttempts: 3,
    run,
    ...over,
  };
}

const ok = (): Promise<JobResult> => Promise.resolve({ status: 'ok', itemsProcessed: 1 });

function options(store: MemoryStore, registry: JobDefinition[], over: Partial<TickOptions> = {}): TickOptions {
  return {
    store,
    registry,
    now: NOW,
    tickId: `tick-${Math.random().toString(36).slice(2)}`,
    budgetMs: 60_000,
    maxUnits: 100,
    concurrency: 2,
    env: NO_ENV,
    makeContext: ({ orgId, slotAt, signal, now }) => ({
      orgId,
      slotAt,
      signal,
      now,
      admin: {} as unknown as SupabaseClient,
      scopedClient: () => null,
    }),
    log: () => {},
    ...over,
  };
}

const newStore = (orgs = [ORG_A, ORG_B]) => new MemoryStore(orgs, () => NOW.getTime());

// ── pure helpers ─────────────────────────────────────────────────────────────

describe('computeDue', () => {
  const spec = parseCron('10 8 * * *');
  const def = { maxLatenessMinutes: 60 };
  const base: JobStateRow = {
    job_key: 'x.y', org_id: ORG_A, enabled: null, cron: null, last_slot_at: null, pending_slot_at: null,
    attempts: 0, consecutive_failures: 0, backoff_until: null, lock_owner: null, lock_expires_at: null,
  };

  it('a never-run job is due at its first slot (attempt 1)', () => {
    expect(computeDue(spec, NOW, undefined, def)).toEqual({ due: true, slot: new Date('2026-10-20T08:10:00Z'), attempt: 1 });
  });

  it('is not due once the slot finished', () => {
    const d = computeDue(spec, NOW, { ...base, last_slot_at: '2026-10-20T08:10:00Z' }, def);
    expect(d).toMatchObject({ due: false, reason: 'done' });
  });

  it('is due again at the next slot', () => {
    const d = computeDue(spec, new Date('2026-10-21T08:11:00Z'), { ...base, last_slot_at: '2026-10-20T08:10:00Z' }, def);
    expect(d).toMatchObject({ due: true, attempt: 1 });
  });

  it('skips a slot older than the lateness window', () => {
    expect(computeDue(spec, new Date('2026-10-20T09:30:00Z'), undefined, def)).toMatchObject({ due: false, reason: 'too_late' });
  });

  it('respects failure backoff, then retries with attempt+1', () => {
    const row = { ...base, pending_slot_at: '2026-10-20T08:10:00.000Z', attempts: 1, backoff_until: '2026-10-20T08:15:00Z' };
    expect(computeDue(spec, NOW, row, def)).toMatchObject({ due: false, reason: 'backoff' });
    expect(computeDue(spec, new Date('2026-10-20T08:16:00Z'), row, def)).toMatchObject({ due: true, attempt: 2 });
  });

  it('backoff grows 5,10,20,40 min and caps at 60', () => {
    expect([1, 2, 3, 4, 5, 9].map((a) => backoffMs(a) / 60_000)).toEqual([5, 10, 20, 40, 60, 60]);
  });

  it('idempotency key is job:org:slot', () => {
    expect(idempotencyKey('controls.nightly', ORG_A, new Date('2026-10-20T08:10:00Z'))).toBe('controls.nightly:org-a:2026-10-20T08:10:00.000Z');
    expect(idempotencyKey('scheduler.prune_runs', null, new Date('2026-10-20T10:00:00Z'))).toBe('scheduler.prune_runs:platform:2026-10-20T10:00:00.000Z');
  });
});

describe('resolveEffectiveConfig', () => {
  const def = job('a.b', ok, { defaultEnabled: false, cron: '0 1 * * *' });
  const row = (p: Partial<JobStateRow>): JobStateRow => ({
    job_key: 'a.b', org_id: null, enabled: null, cron: null, last_slot_at: null, pending_slot_at: null,
    attempts: 0, consecutive_failures: 0, backoff_until: null, lock_owner: null, lock_expires_at: null, ...p,
  });
  it('falls back to the registry', () => {
    expect(resolveEffectiveConfig(def, undefined, undefined)).toEqual({ enabled: false, cron: '0 1 * * *' });
  });
  it('platform row overrides registry; org row overrides platform', () => {
    expect(resolveEffectiveConfig(def, undefined, row({ enabled: true, cron: '0 2 * * *' }))).toEqual({ enabled: true, cron: '0 2 * * *' });
    expect(resolveEffectiveConfig(def, row({ org_id: ORG_A, enabled: false }), row({ enabled: true }))).toEqual({ enabled: false, cron: '0 1 * * *' });
  });
});

// ── tick behaviour ───────────────────────────────────────────────────────────

describe('runTick', () => {
  it('fans an org job out per tenant, records ok runs, and is idempotent on re-tick', async () => {
    const store = newStore();
    const fn = vi.fn(ok);
    const reg = [job('t.daily', fn)];
    const r1 = await runTick(options(store, reg));
    expect(fn).toHaveBeenCalledTimes(2);
    expect(r1.units.map((u) => [u.orgId, u.outcome, u.status])).toEqual([
      [ORG_A, 'ran', 'ok'],
      [ORG_B, 'ran', 'ok'],
    ]);
    expect(store.runs.map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(store.get('t.daily', ORG_A)?.last_slot_at).toBe('2026-10-20T08:10:00.000Z');
    expect(store.get('t.daily', ORG_A)?.lock_owner).toBeNull();

    const r2 = await runTick(options(store, reg));
    expect(r2.due).toBe(0);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(store.runs).toHaveLength(2);
  });

  it('a platform job runs once with orgId null', async () => {
    const store = newStore();
    const seen: Array<string | null> = [];
    await runTick(options(store, [job('p.house', async (c) => { seen.push(c.orgId); return { status: 'ok' }; }, { scope: 'platform' })]));
    expect(seen).toEqual([null]);
    expect(store.runs[0]).toMatchObject({ orgId: null, idempotencyKey: 'p.house:platform:2026-10-20T08:10:00.000Z' });
  });

  describe('single-flight lock', () => {
    it('skips a unit whose lock is held by another live tick', async () => {
      const store = newStore([ORG_A]);
      store.seed('t.daily', ORG_A, { lock_owner: 'other-tick', lock_expires_at: '2026-10-20T08:20:00Z' });
      const fn = vi.fn(ok);
      const r = await runTick(options(store, [job('t.daily', fn)]));
      expect(fn).not.toHaveBeenCalled();
      expect(r.units[0].outcome).toBe('locked');
      expect(store.get('t.daily', ORG_A)?.lock_owner).toBe('other-tick'); // never stolen or cleared
      expect(store.runs).toHaveLength(0);
    });

    it('reclaims an EXPIRED lock and marks the dead holder\'s running row failed', async () => {
      const store = newStore([ORG_A]);
      store.seed('t.daily', ORG_A, { lock_owner: 'dead-tick', lock_expires_at: '2026-10-20T08:11:00Z' });
      store.runs.push({
        id: 'stale', jobKey: 't.daily', orgId: ORG_A, slotAt: '2026-10-20T08:10:00.000Z', attempt: 1,
        idempotencyKey: 't.daily:org-a:2026-10-20T08:10:00.000Z', trigger: 'cron', status: 'running',
      });
      const fn = vi.fn(ok);
      await runTick(options(store, [job('t.daily', fn)]));
      expect(fn).toHaveBeenCalledTimes(1);
      expect(store.runs.find((r) => r.id === 'stale')?.status).toBe('failed');
      expect(store.runs.filter((r) => r.status === 'ok')).toHaveLength(1);
    });

    it('two overlapping ticks run a unit exactly once', async () => {
      const store = newStore([ORG_A]);
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const fn = vi.fn(async () => { await gate; return { status: 'ok' as const }; });
      const reg = [job('t.daily', fn)];
      const p1 = runTick(options(store, reg, { tickId: 'tick-1' }));
      const p2 = runTick(options(store, reg, { tickId: 'tick-2' }));
      await new Promise((r) => setTimeout(r, 10));
      release();
      const [a, b] = await Promise.all([p1, p2]);
      expect(fn).toHaveBeenCalledTimes(1);
      expect([...a.units, ...b.units].map((u) => u.outcome).sort()).toEqual(['locked', 'ran']);
    });
  });

  it('idempotency: a slot that already has a finished run is not re-run even if state was lost', async () => {
    const store = newStore([ORG_A]);
    store.runs.push({
      id: 'done', jobKey: 't.daily', orgId: ORG_A, slotAt: '2026-10-20T08:10:00.000Z', attempt: 1,
      idempotencyKey: 't.daily:org-a:2026-10-20T08:10:00.000Z', trigger: 'cron', status: 'ok',
    });
    const fn = vi.fn(ok);
    const r = await runTick(options(store, [job('t.daily', fn)]));
    expect(fn).not.toHaveBeenCalled();
    expect(r.units[0].outcome).toBe('duplicate');
    expect(store.get('t.daily', ORG_A)?.last_slot_at).toBe('2026-10-20T08:10:00.000Z');
    expect(store.runs).toHaveLength(1);
  });

  describe('kill switches — a disabled job never runs', () => {
    it('registry defaultEnabled=false', async () => {
      const store = newStore();
      const fn = vi.fn(ok);
      await runTick(options(store, [job('t.off', fn, { defaultEnabled: false })]));
      expect(fn).not.toHaveBeenCalled();
      expect(store.runs).toHaveLength(0);
    });

    it('a stub (implemented=false) never runs even if the DB enables it', async () => {
      const store = newStore();
      store.seed('t.stub', null, { enabled: true });
      store.seed('t.stub', ORG_A, { enabled: true });
      const fn = vi.fn(ok);
      await runTick(options(store, [job('t.stub', fn, { implemented: false, defaultEnabled: false })]));
      expect(fn).not.toHaveBeenCalled();
    });

    it('platform row enabled=false disables it for every tenant', async () => {
      const store = newStore();
      store.seed('t.daily', null, { enabled: false });
      const fn = vi.fn(ok);
      await runTick(options(store, [job('t.daily', fn)]));
      expect(fn).not.toHaveBeenCalled();
    });

    it('org row enabled=false disables it for that tenant only', async () => {
      const store = newStore();
      store.seed('t.daily', ORG_A, { enabled: false });
      const seen: Array<string | null> = [];
      await runTick(options(store, [job('t.daily', async (c) => { seen.push(c.orgId); return { status: 'ok' }; })]));
      expect(seen).toEqual([ORG_B]);
    });

    it('env SCHEDULER_DISABLED_JOBS and SCHEDULER_PAUSED', async () => {
      const store = newStore();
      const fn = vi.fn(ok);
      await runTick(options(store, [job('t.daily', fn)], { env: { paused: false, disabledJobs: new Set(['t.daily']) } }));
      const paused = await runTick(options(store, [job('t.daily', fn)], { env: { paused: true, disabledJobs: new Set() } }));
      expect(fn).not.toHaveBeenCalled();
      expect(paused.paused).toBe(true);
    });
  });

  describe('errors never crash the tick', () => {
    it('a throwing job is recorded failed with its error; other jobs still run', async () => {
      const store = newStore([ORG_A]);
      const good = vi.fn(ok);
      const reg = [
        job('t.bad', async () => { throw new Error('boom: table missing'); }),
        job('t.good', good),
      ];
      const r = await runTick(options(store, reg));
      expect(good).toHaveBeenCalledTimes(1);
      const bad = store.runs.find((x) => x.jobKey === 't.bad');
      expect(bad?.status).toBe('failed');
      expect(bad?.finish?.error).toBe('boom: table missing');
      expect(r.units.find((u) => u.job === 't.bad')).toMatchObject({ outcome: 'ran', status: 'failed' });
      const st = store.get('t.bad', ORG_A);
      expect(st?.last_slot_at).toBeNull(); // slot NOT finished — it will retry
      expect(st?.pending_slot_at).toBe('2026-10-20T08:10:00.000Z');
      expect(st?.attempts).toBe(1);
      expect(st?.consecutive_failures).toBe(1);
      expect(st?.backoff_until).toBe('2026-10-20T08:17:00.000Z');
      expect(st?.lock_owner).toBeNull();
    });

    it('retries after backoff and gives up after maxAttempts', async () => {
      let t = NOW.getTime();
      const store = new MemoryStore([ORG_A], () => t);
      const fn = vi.fn(async (): Promise<JobResult> => ({ status: 'failed', error: 'upstream down' }));
      const reg = [job('t.flaky', fn, { maxAttempts: 2 })];
      await runTick(options(store, reg, { now: new Date(t) }));
      await runTick(options(store, reg, { now: new Date(t + 60_000) })); // inside backoff
      expect(fn).toHaveBeenCalledTimes(1);
      t += 6 * 60_000;
      await runTick(options(store, reg, { now: new Date(t) }));
      expect(fn).toHaveBeenCalledTimes(2);
      expect(store.runs.map((r) => r.attempt)).toEqual([1, 2]);
      const st = store.get('t.flaky', ORG_A);
      expect(st?.last_slot_at).toBe('2026-10-20T08:10:00.000Z'); // gave up on the slot
      expect(st?.consecutive_failures).toBe(2);
      t += 60 * 60_000;
      await runTick(options(store, reg, { now: new Date(t) }));
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('a store failure for one unit is reported, not thrown', async () => {
      const store = newStore([ORG_A]);
      store.startRun = async () => { throw new Error('db unavailable'); };
      const r = await runTick(options(store, [job('t.daily', ok)]));
      expect(r.units[0]).toMatchObject({ outcome: 'error', error: 'db unavailable' });
      expect(store.get('t.daily', ORG_A)?.lock_owner).toBeNull();
    });

    it('a timed-out job is recorded failed and its lock is left to expire', async () => {
      const store = newStore([ORG_A]);
      let aborted = false;
      const hang = (c: JobContext) => new Promise<JobResult>(() => { c.signal.addEventListener('abort', () => { aborted = true; }); });
      const r = await runTick(options(store, [job('t.hang', hang, { timeoutMs: 30 })]));
      expect(r.units[0]).toMatchObject({ outcome: 'ran', status: 'failed' });
      expect(store.runs[0].finish?.error).toMatch(/timed out/);
      expect(aborted).toBe(true);
      expect(store.get('t.hang', ORG_A)?.lock_owner).not.toBeNull();
    });

    it('an invalid cron override is reported as a config error and skipped', async () => {
      const store = newStore([ORG_A]);
      store.seed('t.daily', null, { cron: 'every day please' });
      const fn = vi.fn(ok);
      const r = await runTick(options(store, [job('t.daily', fn)]));
      expect(fn).not.toHaveBeenCalled();
      expect(r.configErrors[0]).toMatchObject({ job: 't.daily', orgId: ORG_A });
    });
  });

  it('caps units per tick and defers the rest (picked up next tick)', async () => {
    const store = newStore();
    const fn = vi.fn(ok);
    const reg = [job('t.daily', fn)];
    const r1 = await runTick(options(store, reg, { maxUnits: 1, concurrency: 1 }));
    expect(r1.units.map((u) => u.outcome)).toEqual(['ran', 'deferred']);
    const r2 = await runTick(options(store, reg, { maxUnits: 1, concurrency: 1 }));
    expect(r2.units.map((u) => [u.orgId, u.outcome])).toEqual([[ORG_B, 'ran']]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('defers a unit when the tick budget cannot fit its timeout', async () => {
    const store = newStore([ORG_A]);
    const fn = vi.fn(ok);
    const r = await runTick(options(store, [job('t.big', fn, { timeoutMs: 120_000 })], { budgetMs: 60_000 }));
    expect(fn).not.toHaveBeenCalled();
    expect(r.units[0].outcome).toBe('deferred');
  });
});
