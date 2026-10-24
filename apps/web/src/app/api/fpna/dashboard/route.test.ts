/**
 * GET /api/fpna/dashboard — number governance: the window is capped at 60 months (400), a
 * non-finance caller's withheld months never reach a figure (trend, variance, KPIs, runway),
 * and finance passes through.
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
vi.mock('@/lib/dates/org-today', () => ({ getOrgToday: async () => '2026-10-24' }));
vi.mock('@/lib/cash/book-cash', () => ({ resolveCashAccountIds: async () => new Set<string>() }));
vi.mock('@/lib/reports/governance/load', async (orig) => ({
  ...(await orig<typeof import('@/lib/reports/governance/load')>()),
  // Jan–Sep closed; released through Jul.
  loadGovernanceFacts: factsLoader(() => facts(company(CO_A, [1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 5, 6, 7]))),
}));
const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const fetchAll = vi.fn(async (_b: unknown, opts?: { label?: string }) => {
  if (opts?.label === 'fpna gl_entries') return { data: MONTHS.map((m) => ({ id: `e${m}`, entry_date: `2026-${String(m).padStart(2, '0')}-15` })), error: null };
  return { data: [], error: null };
});
vi.mock('@/lib/supabase/fetch-all', () => ({
  fetchAll: (b: unknown, o?: { label?: string }) => fetchAll(b, o),
  // $100 of revenue per entry.
  fetchAllIn: async () => ({
    data: MONTHS.map((m) => ({ gl_entry_id: `e${m}`, account_id: 'rev', debit_cents: 0, credit_cents: 10_000, account: { account_number: '4000', name: 'Revenue', account_type: 'REVENUE' } })),
    error: null,
  }),
}));

const { GET } = await import('./route');
const call = (qs: string) => GET(new Request(`http://localhost/api/fpna/dashboard?${qs}`));

beforeEach(() => {
  finance = false;
  fetchAll.mockClear();
});

describe('GET /api/fpna/dashboard — governance', () => {
  it('refuses a window longer than 60 months (400) before reading the ledger', async () => {
    const res = await call(`period_end=2026-09&period_start=2020-01&basis=range&location_id=${CO_A}`);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('RANGE_TOO_LONG');
    expect(fetchAll).not.toHaveBeenCalled();
  });

  it('non-finance: withheld months are dropped from the trend, the variance and the KPIs', async () => {
    const res = await call(`fiscal_year=2026&as_of_month=9&location_id=${CO_A}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.trend).toHaveLength(7); // Jan–Jul only
    expect(body.trend.every((p: { revenueCents: number }) => p.revenueCents === 10_000)).toBe(true);
    expect(body.kpis).toBeNull(); // September is not released
    expect(body.runway).toBeNull(); // no released balance as of September
    expect(body.governance.withheldPeriods).toEqual(['2026-08', '2026-09', '2026-10', '2026-11', '2026-12']);
    const revenue = body.variance.rows.find((r: { key: string }) => r.key === '4000');
    expect(revenue.actualCents).toBe(70_000); // actual-to-date stops at the last released month
  });

  it('non-finance without an explicit as-of month defaults to the latest released month', async () => {
    const res = await call(`fiscal_year=2026&location_id=${CO_A}`);
    const body = await res.json();
    expect(body.period.asOfMonth).toBe(7);
  });

  it('finance passes through (every month, preview)', async () => {
    finance = true;
    const res = await call(`fiscal_year=2026&as_of_month=9&location_id=${CO_A}`);
    const body = await res.json();
    expect(body.trend).toHaveLength(12);
    expect(body.kpis).not.toBeNull();
    expect(body.governance.audience).toBe('finance');
  });
});
