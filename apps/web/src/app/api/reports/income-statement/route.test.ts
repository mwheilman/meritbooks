/**
 * Classic P&L routes — number governance for non-finance callers: a range needs every month
 * released for every company in scope (403 otherwise); the month-columned P&L drops withheld
 * months' lines before aggregation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import type { ZodSchema } from 'zod';
import { CO_A, CO_B, chainSupabase, company, facts, factsLoader } from '@/test/governance-facts';

let finance = false;
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
  // A released through Aug; B only through Jul.
  loadGovernanceFacts: factsLoader(() => facts(company(CO_A, [1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 5, 6, 7, 8]), company(CO_B, [1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 5, 6, 7]))),
}));
const line = (m: number) => ({
  account_id: 'rev',
  debit_cents: 0,
  credit_cents: 10_000,
  location_id: CO_A,
  gl_entry_id: `e${m}`,
  accounts: { account_number: '4000', name: 'Revenue', account_type: 'REVENUE', account_groups: { name: 'Sales', display_order: 1, account_sub_types: { name: 'Revenue', display_order: 1, account_types: { name: 'Revenue', normal_balance: 'CREDIT', display_order: 1 } } } },
  gl_entries: { id: `e${m}`, entry_date: `2026-${String(m).padStart(2, '0')}-15`, status: 'POSTED' },
});
const fetchAll = vi.fn(async () => ({ data: [1, 2, 3, 4, 5, 6, 7, 8, 9].map(line), error: null }));
vi.mock('@/lib/supabase/fetch-all', () => ({ fetchAll: () => fetchAll(), fetchAllIn: async () => ({ data: [], error: null }) }));

const is = (await import('./route')).GET;
const byMonth = (await import('@/app/api/reports/pnl-by-month/route')).GET;

beforeEach(() => {
  finance = false;
  fetchAll.mockClear();
});

describe('income statement', () => {
  it('a combined month needs every company released → 403 for Aug with A + B', async () => {
    const res = await is(new Request(`http://localhost/api/reports/income-statement?start_date=2026-07-01&end_date=2026-08-31&location_ids=${CO_A},${CO_B}`));
    expect(res.status).toBe(403);
    expect((await res.json()).periodKeys).toEqual(['2026-08']);
    expect(fetchAll).not.toHaveBeenCalled();
  });

  it('A alone through Aug is released → 200', async () => {
    const res = await is(new Request(`http://localhost/api/reports/income-statement?start_date=2026-07-01&end_date=2026-08-31&location_id=${CO_A}`));
    expect(res.status).toBe(200);
  });
});

describe('P&L by month', () => {
  it('drops withheld months before aggregation (non-finance)', async () => {
    const res = await byMonth(new Request(`http://localhost/api/reports/pnl-by-month?year=2026&location_id=${CO_A}`));
    const body = await res.json();
    const rev = body.sections.find((s: { type: string }) => s.type === 'REVENUE');
    expect(rev.months.slice(0, 9)).toEqual([10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 0]);
    expect(rev.totalCents).toBe(80_000);
    expect(body.withheldMonths).toEqual(['2026-09', '2026-10', '2026-11', '2026-12']);
  });

  it('finance sees every month', async () => {
    finance = true;
    const res = await byMonth(new Request(`http://localhost/api/reports/pnl-by-month?year=2026&location_id=${CO_A}`));
    const body = await res.json();
    expect(body.sections.find((s: { type: string }) => s.type === 'REVENUE').totalCents).toBe(90_000);
  });
});
