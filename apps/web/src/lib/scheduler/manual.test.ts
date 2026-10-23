/** Security review M7 — "Run now" honours the operator kill switches the cron tick does. */
import { describe, it, expect } from 'vitest';
import { assertNotKilled, ManualRunError } from './manual';
import type { JobDefinition, JobStateRow, SchedulerStore } from './types';

const def = { key: 'ar.recurring', label: 'Recurring invoices' } as unknown as JobDefinition;
const row = (orgId: string | null, enabled: boolean | null): JobStateRow => ({
  job_key: 'ar.recurring', org_id: orgId, enabled, cron: null, last_slot_at: null, pending_slot_at: null,
  attempts: 0, consecutive_failures: 0, backoff_until: null, lock_owner: null, lock_expires_at: null,
});
const store = (rows: JobStateRow[]) => ({ listStates: async () => rows }) as unknown as SchedulerStore;
const env = (over: Partial<{ paused: boolean; disabledJobs: Set<string> }> = {}) => ({ paused: false, disabledJobs: new Set<string>(), ...over });

describe('assertNotKilled', () => {
  it('runs when nothing is switched off (a tenant\'s own off switch does not block Run now)', async () => {
    await expect(assertNotKilled(def, store([row('org1', false)]), env())).resolves.toBeUndefined();
  });
  it('SCHEDULER_PAUSED refuses with 503', async () => {
    const e = await assertNotKilled(def, store([]), env({ paused: true })).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ManualRunError);
    expect((e as ManualRunError).status).toBe(503);
    expect((e as Error).message).toMatch(/paused/);
  });
  it('SCHEDULER_DISABLED_JOBS refuses that job', async () => {
    const e = await assertNotKilled(def, store([]), env({ disabledJobs: new Set(['ar.recurring']) })).catch((x: unknown) => x);
    expect((e as ManualRunError).status).toBe(409);
    expect((e as Error).message).toMatch(/switched off by the platform operator/);
  });
  it('the PLATFORM row turned off refuses, even if the tenant row is on', async () => {
    const e = await assertNotKilled(def, store([row(null, false), row('org1', true)]), env()).catch((x: unknown) => x);
    expect((e as ManualRunError).status).toBe(409);
    expect((e as Error).message).toMatch(/every company/);
  });
});
