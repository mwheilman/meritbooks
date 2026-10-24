/**
 * GET /api/period/performance — number governance: a non-finance caller never receives a
 * withheld month's figures (dropped from byMonth and from the window total); finance passes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import type { ZodSchema } from 'zod';
import { CO_A, chainSupabase, company, facts, factsLoader } from '@/test/governance-facts';

let finance = false;
const supabase = chainSupabase((t) => (t === 'organizations' ? { data: { fiscal_year_start_month: 1 }, error: null } : { data: null, error: null }));

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
vi.mock('@/lib/reports/governance/load', async (orig) => ({
  ...(await orig<typeof import('@/lib/reports/governance/load')>()),
  loadGovernanceFacts: factsLoader(() => facts(company(CO_A, [1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 5, 6, 7]))),
}));
// One $100 revenue line per month, Jan–Sep 2026.
vi.mock('@/lib/supabase/fetch-all', () => ({
  fetchAll: async () => ({
    data: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((m) => ({
      id: `l${m}`,
      debit_cents: 0,
      credit_cents: 10_000,
      accounts: { account_type: 'REVENUE' },
      gl_entries: { entry_date: `2026-${String(m).padStart(2, '0')}-15`, status: 'POSTED' },
    })),
    error: null,
  }),
  fetchAllIn: async () => ({ data: [], error: null }),
}));

const { GET } = await import('./route');
const call = (qs: string) => GET(new Request(`http://localhost/api/period/performance?${qs}`));

beforeEach(() => {
  finance = false;
});

describe('GET /api/period/performance — governance', () => {
  it('non-finance: unreleased months are dropped, never summed', async () => {
    const res = await call(`period_end=2026-09&basis=ytd&location_id=${CO_A}&compare=prior_period`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.byMonth.map((r: { month: string }) => r.month)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']);
    expect(body.data.current.revenueCents).toBe(70_000);
    expect(body.data.withheldMonths).toEqual(['2026-08', '2026-09']);
    expect(body.governance.audience).toBe('non_finance');
    // The prior-period comparison (before 2026) has no fiscal periods → withheld, not partial.
    expect(body.data.comparison.figures).toBeNull();
  });

  it('finance: every month passes through, labelled preview', async () => {
    finance = true;
    const res = await call(`period_end=2026-09&basis=ytd&location_id=${CO_A}`);
    const body = await res.json();
    expect(body.data.byMonth).toHaveLength(9);
    expect(body.data.current.revenueCents).toBe(90_000);
    expect(body.governance.audience).toBe('finance');
    expect(body.governance.watermark).toBe('preview');
  });
});
