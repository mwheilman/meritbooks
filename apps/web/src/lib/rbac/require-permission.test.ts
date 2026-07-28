/**
 * require-permission — the pure authorization decision.
 *
 * requirePermission() itself resolves the caller's role from the DB (employee
 * record) and therefore needs Supabase; that path is covered by the route-level
 * pattern and will get integration coverage once the identity/org-resolution FPB
 * lands (see the TODO in require-permission.ts). The DECISION logic is factored
 * out into permissionDenied(), which is pure and asserted exhaustively here:
 * allowed → null, denied → 403 { code: 'FORBIDDEN' }, and it fails CLOSED for an
 * unknown or absent role.
 */

import { describe, it, expect } from 'vitest';
import { permissionDenied } from './require-permission';

describe('permissionDenied — allowed cases', () => {
  it('allows a company_admin to post journal entries (returns null)', () => {
    expect(permissionDenied('company_admin', 'journal_entries', 'post')).toBeNull();
  });

  it('allows a merit_controller to post journal entries', () => {
    expect(permissionDenied('merit_controller', 'journal_entries', 'post')).toBeNull();
  });

  it('allows an accounting_specialist to create (but is separately denied post)', () => {
    expect(permissionDenied('accounting_specialist', 'journal_entries', 'create')).toBeNull();
  });
});

describe('permissionDenied — denied cases fail closed with 403', () => {
  it('denies accounting_specialist from posting journal entries (create-only role)', () => {
    const res = permissionDenied('accounting_specialist', 'journal_entries', 'post');
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it('denies check_processor from posting journal entries (no feature access)', () => {
    const res = permissionDenied('check_processor', 'journal_entries', 'post');
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it('denies an unknown role (fails closed)', () => {
    // @ts-expect-error — deliberately passing an invalid role to prove fail-closed
    const res = permissionDenied('not_a_real_role', 'journal_entries', 'post');
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it('denies a null/absent role (no employee record resolved)', () => {
    const res = permissionDenied(null, 'journal_entries', 'post');
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it('returns the FORBIDDEN error code in the body', async () => {
    const res = permissionDenied(null, 'journal_entries', 'post');
    const body = await res!.json();
    expect(body).toEqual({ error: 'Forbidden', code: 'FORBIDDEN' });
  });
});
