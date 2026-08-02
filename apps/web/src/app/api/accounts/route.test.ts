/**
 * GET /api/accounts — org-scoping proof (identity gate #9 cross-tenant read fix).
 *
 * The regression this locks: GET used to run on the admin (RLS-bypassing) client
 * with no org filter, leaking every tenant's chart of accounts. It must now (a)
 * fail closed on auth and (b) read through the REQUEST-SCOPED RLS client
 * (requireAuthedContext → createAuthedSupabase), never the admin client. We assert
 * both by faking the context client and making createAdminSupabase() throw if the
 * GET path touches it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// The RLS-scoped client the route must use. A chainable, awaitable query stub that
// records the table it was opened against and resolves to a fixed org's rows.
const orgRows = [
  {
    id: 'acct-1',
    account_number: '1000',
    name: 'Cash',
    account_type: 'ASSET',
    is_active: true,
    is_control_account: false,
    is_company_specific: false,
    is_bank_account: true,
    is_credit_card: false,
    approval_status: 'APPROVED',
    requested_by: null,
    approved_by: null,
    approved_at: null,
    require_department: false,
    require_class: false,
    require_item: false,
    created_at: '2026-01-01',
    account_groups: { name: 'Cash', display_order: 1, account_sub_types: { name: 'Bank', display_order: 1, account_types: { name: 'Assets', normal_balance: 'DEBIT', display_order: 1 } } },
  },
];

function makeQuery(result: { data: unknown; error: unknown }) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'order', 'or', 'eq']) q[m] = () => q;
  // Thenable so `await query` resolves to {data,error}.
  (q as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve(result);
  return q;
}

const fromSpy = vi.fn(() => makeQuery({ data: orgRows, error: null }));
const rlsSupabase = { from: fromSpy };

const requireAuthedContext = vi.fn();
vi.mock('@/lib/api-handler', () => ({
  requireAuthedContext: () => requireAuthedContext(),
  requireAuth: vi.fn(),
}));

// The admin client must NOT be used on the GET path.
const adminUsed = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createAdminSupabase: () => {
    adminUsed();
    throw new Error('GET /api/accounts must not use the admin (RLS-bypassing) client');
  },
}));

import { GET } from './route';

beforeEach(() => {
  fromSpy.mockClear();
  adminUsed.mockClear();
  requireAuthedContext.mockReset();
});

describe('GET /api/accounts is org-scoped (RLS), not admin', () => {
  it('reads through the request-scoped RLS client and returns only that org', async () => {
    requireAuthedContext.mockResolvedValue({ userId: 'u1', orgId: 'org-1', supabase: rlsSupabase });

    const res = await GET(new Request('http://localhost/api/accounts'));
    const body = await res.json();

    // Went through the RLS client...
    expect(fromSpy).toHaveBeenCalledWith('accounts');
    // ...and never the admin client.
    expect(adminUsed).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].accountNumber).toBe('1000');
  });

  it('fails closed when unauthenticated (context returns a 401 response)', async () => {
    const { NextResponse } = await import('next/server');
    requireAuthedContext.mockResolvedValue(
      NextResponse.json({ error: 'Unauthorized', code: 'UNAUTHENTICATED' }, { status: 401 }),
    );

    const res = await GET(new Request('http://localhost/api/accounts'));
    expect(res.status).toBe(401);
    expect(fromSpy).not.toHaveBeenCalled();
    expect(adminUsed).not.toHaveBeenCalled();
  });
});
