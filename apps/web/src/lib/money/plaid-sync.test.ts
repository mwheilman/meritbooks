import { describe, expect, it, vi } from 'vitest';
import { feedVerdict, runBankDailyPullJob, STALE_AFTER_HOURS } from './plaid-sync';

vi.mock('@/lib/money/plaid-feed', () => ({
  syncAllPlaidItems: vi.fn(async () => ({ itemsSynced: 2, transactionsAdded: 7, transactionsModified: 1, transactionsRemoved: 0, balancesRefreshed: 3, reauthNeeded: [{ plaidItemId: 'i2', institutionName: 'Chase' }], errors: [] })),
}));

const NOW = new Date('2026-10-23T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe('bank-feed freshness verdict (FPB §17.5)', () => {
  it('no Items → not connected', () => {
    expect(feedVerdict([], NOW, 'test').verdict).toBe('not_connected');
  });
  it('synced recently → healthy; the newest Item counts', () => {
    const v = feedVerdict([{ status: 'active', lastSyncedAt: hoursAgo(90), environment: 'test' }, { status: 'active', lastSyncedAt: hoursAgo(3), environment: 'test' }], NOW, 'test');
    expect(v).toEqual({ verdict: 'healthy', lastSyncedAt: hoursAgo(3), hoursSinceSync: 3 });
  });
  it(`no sync for ${STALE_AFTER_HOURS} h (or never) → stale`, () => {
    expect(feedVerdict([{ status: 'active', lastSyncedAt: hoursAgo(STALE_AFTER_HOURS), environment: 'test' }], NOW, 'test').verdict).toBe('stale');
    expect(feedVerdict([{ status: 'active', lastSyncedAt: null, environment: 'test' }], NOW, 'test').verdict).toBe('stale');
  });
  it('re-login needed, an error, or a Sandbox Item under Production → attention', () => {
    expect(feedVerdict([{ status: 'login_required', lastSyncedAt: hoursAgo(1), environment: 'test' }], NOW, 'test').verdict).toBe('attention');
    expect(feedVerdict([{ status: 'active', lastSyncedAt: hoursAgo(1), environment: 'test' }], NOW, 'live').verdict).toBe('attention');
  });
});

describe('scheduler entry point (bank.daily_pull)', () => {
  const ctx = (orgId: string | null, count: number) => ({
    orgId, now: NOW, slotAt: NOW, signal: new AbortController().signal, scopedClient: () => null,
    admin: { from: () => ({ select: () => ({ eq: async () => ({ count }) }) }) } as never,
  });
  it('skips platform scope, an unconfigured server, and tenants with no bank', async () => {
    vi.stubEnv('PLAID_CLIENT_ID', 'c'); vi.stubEnv('PLAID_SECRET', 's');
    expect((await runBankDailyPullJob(ctx(null, 1))).status).toBe('skipped');
    expect((await runBankDailyPullJob(ctx('org', 0))).status).toBe('skipped');
    vi.unstubAllEnvs();
    vi.stubEnv('PLAID_CLIENT_ID', '');
    expect((await runBankDailyPullJob(ctx('org', 1))).summary).toMatch(/not configured/);
    vi.unstubAllEnvs();
  });
  it('reports a partial run with counts and a plain-English summary', async () => {
    vi.stubEnv('PLAID_CLIENT_ID', 'c'); vi.stubEnv('PLAID_SECRET', 's');
    const r = await runBankDailyPullJob(ctx('org', 2));
    expect(r.status).toBe('partial');
    expect(r.itemsProcessed).toBe(2);
    expect(r.counts).toMatchObject({ added: 7, needs_relogin: 1 });
    expect(r.summary).toMatch(/7 new bank transactions from 2 connections; 1 needs the bank login again/);
    vi.unstubAllEnvs();
  });
});
