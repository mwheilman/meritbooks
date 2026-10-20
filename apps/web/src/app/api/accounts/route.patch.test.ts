/**
 * PATCH /api/accounts — approve/reject must actually succeed and report failures
 * (audit 06 §5 bug 6). The regression: approve wrote the Clerk text user id into
 * accounts.approved_by (a uuid column), so every approve failed with an
 * invalid-uuid error that the page swallowed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let updatePayload: Record<string, unknown> | null = null;
let updateResult: { data: unknown; error: unknown } = { data: [], error: null };

function makeUpdateChain() {
  const q: Record<string, unknown> = {};
  q.update = (payload: Record<string, unknown>) => { updatePayload = payload; return q; };
  q.eq = () => q;
  q.select = () => Promise.resolve(updateResult);
  return q;
}

vi.mock('@/lib/api-handler', () => ({
  requireAuthedContext: vi.fn(),
  requireAuth: vi.fn(async () => ({ userId: 'user_2abcClerkTextId', orgId: 'org-1' })),
}));
vi.mock('@/lib/rbac/require-permission', () => ({
  requirePermission: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/lib/supabase/server', () => ({
  createAdminSupabase: () => ({ from: () => makeUpdateChain() }),
}));

import { PATCH } from './route';

function req(body: unknown) {
  return new Request('http://localhost/api/accounts', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  updatePayload = null;
  updateResult = { data: [], error: null };
});

describe('PATCH /api/accounts approve/reject', () => {
  it('never writes a non-uuid actor id into the uuid approved_by column', async () => {
    updateResult = { data: [{ id: 'a1', account_number: '6100', name: 'Supplies', approval_status: 'APPROVED' }], error: null };
    const res = await PATCH(req({ account_id: 'a1', action: 'approve' }));
    expect(res.status).toBe(200);
    const approvedBy = updatePayload?.approved_by;
    expect(approvedBy === null || (typeof approvedBy === 'string' && UUID_RE.test(approvedBy))).toBe(true);
    expect(updatePayload?.approval_status).toBe('APPROVED');
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.account.account_number).toBe('6100');
  });

  it('returns 404 (not a silent success) when no row in the org matched', async () => {
    updateResult = { data: [], error: null };
    const res = await PATCH(req({ account_id: 'missing', action: 'reject' }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
  });

  it('surfaces a database error as a 500 with its message', async () => {
    updateResult = { data: null, error: { message: 'boom' } };
    const res = await PATCH(req({ account_id: 'a1', action: 'approve' }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('boom');
  });
});
