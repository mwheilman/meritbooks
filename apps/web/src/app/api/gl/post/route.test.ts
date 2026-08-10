/**
 * POST /api/gl/post — empty-org rejection (LOW-3).
 *
 * The regression this locks: the route used to hand the posting service
 * `org_id: orgId ?? ''`, i.e. it would attempt an UNSCOPED post when the tenant
 * claim was missing. It must now reject with 400 (code NO_ORG) BEFORE authorizing,
 * building the admin client, or calling the posting service.
 *
 * We fake requireAuth to yield an empty org and make both the permission check and
 * the admin client throw if the route ever reaches them.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const requireAuth = vi.fn();
vi.mock('@/lib/api-handler', () => ({
  requireAuth: () => requireAuth(),
  requireAuthedContext: vi.fn(),
}));

// Must NOT be reached on the empty-org path.
const permissionUsed = vi.fn();
vi.mock('@/lib/rbac/require-permission', () => ({
  requirePermission: () => {
    permissionUsed();
    throw new Error('requirePermission must not run when the org claim is missing');
  },
}));

const adminUsed = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createAdminSupabase: () => {
    adminUsed();
    throw new Error('createAdminSupabase must not run when the org claim is missing');
  },
}));

import { POST } from './route';

beforeEach(() => {
  requireAuth.mockReset();
  permissionUsed.mockClear();
  adminUsed.mockClear();
});

describe('POST /api/gl/post rejects an empty org', () => {
  it('returns 400 NO_ORG and never authorizes or posts', async () => {
    requireAuth.mockResolvedValue({ userId: 'u1', orgId: '' });

    const res = await POST(
      new Request('http://localhost/api/gl/post', { method: 'POST', body: '{}' }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe('NO_ORG');
    expect(permissionUsed).not.toHaveBeenCalled();
    expect(adminUsed).not.toHaveBeenCalled();
  });
});
