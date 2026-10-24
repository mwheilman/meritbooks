/**
 * Balance sheet + trial balance — the CUMULATIVE rule: a non-finance caller gets 403
 * NOT_RELEASED unless every month from the first fiscal period through the as-of month is
 * released (so a hidden month can't be derived from two released balance sheets).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import type { ZodSchema } from 'zod';
import { CO_A, chainSupabase, company, facts, factsLoader } from '@/test/governance-facts';
import type { CompanyFacts } from '@/lib/reports/governance/types';

let finance = false;
let co: CompanyFacts = company(CO_A, [6, 7, 8], [6, 7, 8]);
const supabase = chainSupabase();

vi.mock('@/lib/api-handler', () => ({
  apiQueryHandler: <T,>(schema: ZodSchema<T>, handler: (p: T, ctx: unknown) => Promise<Response>) => async (req: Request) => {
    const parsed = schema.safeParse(Object.fromEntries(new URL(req.url).searchParams.entries()));
    if (!parsed.success) return NextResponse.json({ error: 'bad' }, { status: 422 });
    return handler(parsed.data, { userId: 'user_1', orgId: 'org-1', supabase });
  },
}));
vi.mock('@/lib/rbac/require-permission', () => ({
  requirePermission: async (_u: string, feature: string) =>
    feature === 'journal_entries' || feature === 'close_mgmt' ? { ok: finance } : { ok: true },
}));
vi.mock('@/lib/dates/org-today', () => ({ getOrgToday: async () => '2026-10-24' }));
vi.mock('@/lib/reports/governance/load', async (orig) => ({
  ...(await orig<typeof import('@/lib/reports/governance/load')>()),
  loadGovernanceFacts: factsLoader(() => facts(co)),
}));
const fetchAll = vi.fn(async () => ({ data: [], error: null }));
vi.mock('@/lib/supabase/fetch-all', () => ({ fetchAll: () => fetchAll(), fetchAllIn: async () => ({ data: [], error: null }) }));
vi.mock('@/lib/reports/bs-earnings', () => ({
  fetchUnclosedEarnings: async () => ({}),
  applyEarningsToBalanceSheet: <T,>(b: T) => b,
}));

const bs = (await import('./route')).GET;
const tb = (await import('@/app/api/gl/trial-balance/route')).GET;

beforeEach(() => {
  finance = false;
  co = company(CO_A, [6, 7, 8], [6, 7, 8]);
  fetchAll.mockClear();
});

describe('balance sheet — cumulative governance', () => {
  it('403 when an earlier month is unreleased, even if the as-of month was released on its own', async () => {
    co = company(CO_A, [6, 7, 8], [6, 8]);
    const res = await bs(new Request(`http://localhost/api/reports/balance-sheet?as_of_date=2026-08-31&location_id=${CO_A}`));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('NOT_RELEASED');
    expect(body.periodKeys).toEqual(['2026-08']);
    expect(fetchAll).not.toHaveBeenCalled(); // no figure is read
  });

  it('200 with governance when every month through the as-of month is released', async () => {
    const res = await bs(new Request(`http://localhost/api/reports/balance-sheet?as_of_date=2026-08-31&location_id=${CO_A}`));
    expect(res.status).toBe(200);
    expect((await res.json()).governance.audience).toBe('non_finance');
  });

  it('finance passes through for an unreleased as-of month', async () => {
    finance = true;
    co = company(CO_A, [6, 7, 8, 9], [6]);
    const res = await bs(new Request(`http://localhost/api/reports/balance-sheet?as_of_date=2026-09-30&location_id=${CO_A}`));
    expect(res.status).toBe(200);
    expect((await res.json()).governance.watermark).toBe('preview');
  });
});

describe('trial balance — balances to date (cumulative through today)', () => {
  it('non-finance: 403 (the current month is not released)', async () => {
    const res = await tb(new Request(`http://localhost/api/gl/trial-balance?location_id=${CO_A}`));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('NOT_RELEASED');
    expect(fetchAll).not.toHaveBeenCalled();
  });

  it('finance: 200', async () => {
    finance = true;
    const res = await tb(new Request(`http://localhost/api/gl/trial-balance?location_id=${CO_A}`));
    expect(res.status).toBe(200);
  });
});
