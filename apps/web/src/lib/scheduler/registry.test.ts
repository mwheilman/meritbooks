/**
 * Registry guard + the "GL jobs only PROPOSE unless the dial allows" rule.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { JOBS, listJobSummaries } from './registry';
import { isValidCron } from './cron';
import { AUTONOMY_FEATURE_KEYS } from '@/lib/autonomy/catalog';
import type { JobContext } from './types';

const mocks = vi.hoisted(() => ({
  recognizeRun: vi.fn(),
  processBillingEvents: vi.fn(async () => ({ processed: 2, rejected: 0, results: [] })),
  processDeptInvoiceEvents: vi.fn(async () => ({ processed: 0, rejected: 0, results: [] })),
  processProgressEvents: vi.fn(async () => ({ processed: 0, rejected: 0, results: [] })),
  runPrepaidAmortizations: vi.fn(),
}));
vi.mock('@/lib/services/rev-rec', () => ({ recognizeRun: mocks.recognizeRun }));
vi.mock('@/lib/services/billing-consumer', () => ({ processBillingEvents: mocks.processBillingEvents }));
vi.mock('@/lib/services/dept-invoice-consumer', () => ({ processDeptInvoiceEvents: mocks.processDeptInvoiceEvents }));
vi.mock('@/lib/services/job-progress', () => ({ processProgressEvents: mocks.processProgressEvents }));
vi.mock('@/lib/prepaid/amortize', () => ({ runPrepaidAmortizations: mocks.runPrepaidAmortizations }));

// Imported after the mocks.
const { runRevRecMonthlyJob, runEventsDrainJob } = await import('./jobs/gl-gated-jobs');

const KEY_RE = /^[a-z0-9_]+(\.[a-z0-9_:-]+)+$/; // mirrors the migration-162 CHECK

describe('job registry', () => {
  it('keys are unique and match the DB CHECK', () => {
    const keys = JOBS.map((j) => j.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k, k).toMatch(KEY_RE);
  });

  it('every cron is valid and every timeout fits the 240 s tick budget', () => {
    for (const j of JOBS) {
      expect(isValidCron(j.cron), `${j.key} cron`).toBe(true);
      expect(j.timeoutMs, j.key).toBeLessThanOrEqual(240_000);
      expect(j.maxAttempts, j.key).toBeGreaterThanOrEqual(1);
    }
  });

  it('implemented jobs have a runner; stubs are disabled, have no runner and a TODO', () => {
    for (const j of JOBS) {
      if (j.implemented) expect(typeof j.run, j.key).toBe('function');
      else {
        expect(j.run, j.key).toBeUndefined();
        expect(j.defaultEnabled, j.key).toBe(false);
        expect(j.todo, j.key).toMatch(/^TODO\(/);
      }
    }
  });

  it('every implemented job that can post to the GL is gated by a catalogued autonomy feature', () => {
    for (const j of JOBS.filter((x) => x.implemented && x.postsToGl)) {
      expect(j.autonomyFeature, j.key).toBeTruthy();
      expect(AUTONOMY_FEATURE_KEYS).toContain(j.autonomyFeature);
    }
  });

  it('registers the loops IA §6 names', () => {
    const keys = new Set(JOBS.map((j) => j.key));
    for (const k of [
      'requests.remind', 'vendors.compliance_scan', 'revrec.monthly', 'reports.packs', 'controls.nightly',
      'close.period_end', 'lenders.prepare', 'access.expiry_sweep', 'access.review_campaign', 'connectors.sync',
      'bank.daily_pull', 'ap.pay_run_propose', 'ar.recurring', 'ar.dunning', 'payroll.funding_check',
    ]) {
      expect(keys.has(k), k).toBe(true);
    }
  });

  it('summaries carry no functions', () => {
    for (const s of listJobSummaries()) expect(Object.values(s).some((v) => typeof v === 'function')).toBe(false);
  });
});

// ── fake service-role client: autonomy tables + core.events ─────────────────

type Row = Record<string, unknown>;

function fakeAdmin(tables: Record<string, Row[]>): SupabaseClient {
  const query = (rows: Row[]) => {
    const filters: Array<(r: Row) => boolean> = [];
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
      maybeSingle: async () => ({ data: rows.filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }),
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
        resolve({ data: rows.filter((r) => filters.every((f) => f(r))), error: null }),
    };
    return q;
  };
  const from = (t: string) => query(tables[t] ?? []);
  return { from, schema: () => ({ from }) } as unknown as SupabaseClient;
}

const ORG = '11111111-1111-1111-1111-111111111111';

function ctx(admin: SupabaseClient, scoped: SupabaseClient | null): JobContext {
  return {
    orgId: ORG,
    now: new Date('2026-11-01T07:02:00Z'),
    slotAt: new Date('2026-11-01T07:00:00Z'),
    signal: new AbortController().signal,
    admin,
    scopedClient: () => scoped,
  };
}

const PENDING_BILLING: Row = {
  org_id: ORG, event_type: 'JOB_BILLING', status: 'pending', payload: { lines: [{ amount_cents: 50_000 }] },
};

describe('GL-posting jobs only propose by default', () => {
  beforeEach(() => {
    mocks.recognizeRun.mockReset();
    mocks.recognizeRun.mockImplementation(async (_db: unknown, _org: string, args: { preview?: boolean }) => ({
      asOf: '2026-10-31', posted: args.preview ? 1 : 1, unchanged: 0, skipped: 0, totalRecognizedDeltaCents: 125_000,
      jobs: [{ jobId: 'j1', method: 'PCT_COSTS_INCURRED', earnedToDateCents: 0, priorRecognizedCents: 0, deltaCents: 125_000, status: 'posted' }],
    }));
    mocks.processBillingEvents.mockClear();
    mocks.processProgressEvents.mockClear();
  });

  it('revrec.monthly with no dial row previews only (as of the prior month end) and never posts', async () => {
    const res = await runRevRecMonthlyJob(ctx(fakeAdmin({}), fakeAdmin({})));
    expect(mocks.recognizeRun).toHaveBeenCalledTimes(1);
    expect(mocks.recognizeRun.mock.calls[0][2]).toMatchObject({ asOf: '2026-10-31', preview: true });
    expect(res).toMatchObject({ status: 'ok', itemsProcessed: 0, counts: { mode: 'proposed' } });
  });

  it('revrec.monthly posts when the dial is AUTO_UNDER_LIMIT and the total is under the cap', async () => {
    const admin = fakeAdmin({
      autonomy_settings: [{ org_id: ORG, feature: 'SCHEDULED_REV_REC', mode: 'AUTO_UNDER_LIMIT', materiality_limit_cents: 500_000 }],
    });
    const res = await runRevRecMonthlyJob(ctx(admin, fakeAdmin({})));
    expect(mocks.recognizeRun).toHaveBeenCalledTimes(2);
    expect(mocks.recognizeRun.mock.calls[1][2]).toMatchObject({ preview: false });
    expect(res.counts).toMatchObject({ mode: 'posted' });
  });

  it('revrec.monthly stays a proposal when over the cap or the kill switch is engaged', async () => {
    const over = fakeAdmin({
      autonomy_settings: [{ org_id: ORG, feature: 'SCHEDULED_REV_REC', mode: 'AUTO_UNDER_LIMIT', materiality_limit_cents: 1_000 }],
    });
    await runRevRecMonthlyJob(ctx(over, fakeAdmin({})));
    const killed = fakeAdmin({
      autonomy_settings: [{ org_id: ORG, feature: 'SCHEDULED_REV_REC', mode: 'AUTO_UNDER_LIMIT', materiality_limit_cents: 500_000 }],
      autonomy_kill_switch: [{ org_id: ORG, engaged: true }],
    });
    await runRevRecMonthlyJob(ctx(killed, fakeAdmin({})));
    expect(mocks.recognizeRun.mock.calls.every((c) => (c[2] as { preview: boolean }).preview === true)).toBe(true);
  });

  it('revrec.monthly fails closed (never uses the admin client) when no scoped client can be minted', async () => {
    const res = await runRevRecMonthlyJob(ctx(fakeAdmin({}), null));
    expect(res.status).toBe('failed');
    expect(mocks.recognizeRun).not.toHaveBeenCalled();
  });

  it('events.drain leaves pending events for a human by default', async () => {
    const res = await runEventsDrainJob(ctx(fakeAdmin({ events: [PENDING_BILLING] }), null));
    expect(mocks.processBillingEvents).not.toHaveBeenCalled();
    expect(res.summary).toMatch(/Waiting for a human/);
    expect(res.counts).toMatchObject({ billing_pending: 1, billing_gate: 'REVIEW' });
  });

  it('events.drain processes billing (scoped to the org) when the dial allows, but never progress events', async () => {
    const admin = fakeAdmin({
      events: [PENDING_BILLING, { org_id: ORG, event_type: 'JOB_PROGRESS', status: 'pending', payload: {} }],
      autonomy_settings: [{ org_id: ORG, feature: 'SCHEDULED_EVENT_DRAIN', mode: 'AUTO_UNDER_LIMIT', materiality_limit_cents: 100_000 }],
    });
    const res = await runEventsDrainJob(ctx(admin, null));
    expect(mocks.processBillingEvents).toHaveBeenCalledWith(admin, ORG);
    expect(mocks.processProgressEvents).not.toHaveBeenCalled();
    expect(res).toMatchObject({ itemsProcessed: 2, counts: { progress_gate: 'REVIEW' } });
  });
});
