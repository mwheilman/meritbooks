/**
 * POST /api/bank-feed/approve — plain (non-split) path, Wave 1 security review: every id the
 * service-role post writes (GL account, department, class, job, vendor) must belong to the
 * caller's org. assertOrgRefs runs for real against a fake tenant store; the GL post must
 * never be reached with a foreign id.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const ORG = '11111111-1111-4111-8111-111111111111';
const TXN = '22222222-2222-4222-8222-222222222222';
const LOC = '33333333-3333-4333-8333-333333333333';
const ACC = '44444444-4444-4444-8444-444444444444';
const VEND = '55555555-5555-4555-8555-555555555555';
const FOREIGN = '99999999-9999-4999-8999-999999999999';

type Row = Record<string, unknown>;
const store: Record<string, Row[]> = {};

function builder(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  const rows = () => (store[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const q = {
    select: () => q,
    eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
    in: (c: string, v: unknown[]) => { filters.push((r) => v.includes(r[c])); return q; },
    single: async () => { const r = rows(); return r.length === 1 ? { data: r[0], error: null } : { data: null, error: { message: 'not found' } }; },
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    then: (ok: (v: { data: Row[]; error: null }) => unknown) => Promise.resolve({ data: rows(), error: null }).then(ok),
  };
  return q;
}
const supabase = {
  from: (t: string) => builder(t),
  schema: (s: string) => ({ from: (t: string) => builder(`${s}.${t}`) }),
  rpc: async () => ({ data: null, error: null }),
};

vi.mock('@/lib/api-handler', () => ({
  apiHandler: (schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } }, handler: (b: unknown, ctx: unknown) => Promise<Response>) =>
    async (req: Request) => {
      const parsed = schema.safeParse(await req.json());
      if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 422 });
      return handler(parsed.data, { userId: 'user_1', orgId: ORG, supabase });
    },
}));
vi.mock('@/lib/rbac/require-permission', () => ({ requirePermission: async () => ({ ok: true, role: 'bookkeeper', orgId: ORG }) }));
const postJournalEntry = vi.fn();
vi.mock('@/lib/services/gl-posting', () => ({ postJournalEntry: (...a: unknown[]) => postJournalEntry(...a) }));
vi.mock('@/lib/posting/lifecycle', () => ({ recordBillPayment: vi.fn() }));
vi.mock('@/lib/services/cost-approval', () => ({ createAttribution: vi.fn() }));
vi.mock('@/lib/services/categorization', () => ({ learnVendorPattern: vi.fn(async () => undefined) }));
vi.mock('@/lib/trust/action-log', () => ({ logHumanAction: vi.fn(async () => undefined) }));
vi.mock('@/lib/bank/splits/service', () => ({
  loadFeedTxn: async () => null,
  loadSplitRows: async () => [],
  markRuleApplied: vi.fn(),
  nextPostingVersion: async () => 1,
  postSplit: vi.fn(),
  rowsToLineInputs: vi.fn(),
  saveSplitRule: vi.fn(),
  validateSplitLines: vi.fn(),
  SplitError: class SplitError extends Error { status = 400; },
}));
const serviceUpdates: Row[] = [];
vi.mock('@/lib/db/scoped-writer', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db/scoped-writer')>('@/lib/db/scoped-writer');
  const w = { from: () => ({ update: (v: Row) => { serviceUpdates.push(v); return { eq: () => ({ eq: async () => ({ error: null }) }) }; } }) };
  return { ...actual, serviceWriter: () => w };
});

import { POST } from './route';

const call = (body: Row) => POST(new Request('http://localhost/api/bank-feed/approve', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  store.bank_transactions = [{
    id: TXN, org_id: ORG, status: 'CATEGORIZED', amount_cents: -1_000, transaction_date: '2026-06-01', description: 'COFFEE',
    match_type: null, matched_bill_id: null, ai_vendor_id: null, bank_accounts: { location_id: LOC, account_id: ACC },
  }];
  store.accounts = [{ id: ACC, org_id: ORG }, { id: FOREIGN, org_id: 'other-org' }];
  store['core.vendors'] = [{ id: VEND, org_id: ORG, name: 'Cafe', display_name: null }, { id: FOREIGN, org_id: 'other-org', name: 'X' }];
  store['core.departments'] = [{ id: FOREIGN, org_id: 'other-org' }];
  store.classes = [];
  store['core.jobs'] = [];
  postJournalEntry.mockReset().mockResolvedValue({ success: true, entry_id: 'je1', entry_number: 'JE-1' });
  serviceUpdates.length = 0;
});

describe('POST /api/bank-feed/approve — plain path org refs', () => {
  it('posts with in-org ids', async () => {
    const res = await call({ transaction_id: TXN, account_id: ACC, vendor_id: VEND });
    expect(res.status).toBe(200);
    expect(postJournalEntry).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a foreign GL account', { account_id: FOREIGN }, /GL account/],
    ['a foreign vendor', { account_id: ACC, vendor_id: FOREIGN }, /vendor/],
    ['a foreign department', { account_id: ACC, department_id: FOREIGN }, /department/],
    ['an unknown class', { account_id: ACC, class_id: FOREIGN }, /class/],
    ['a foreign job', { account_id: ACC, job_id: FOREIGN }, /job/],
  ])('refuses %s (403) before anything posts', async (_l, extra, msg) => {
    const res = await call({ transaction_id: TXN, ...extra });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(msg);
    expect(postJournalEntry).not.toHaveBeenCalled();
    expect(serviceUpdates).toHaveLength(0);
  });
});
