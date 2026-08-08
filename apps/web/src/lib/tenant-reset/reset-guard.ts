/**
 * Authority gate for the destructive "reset tenant to a clean slate" flow.
 *
 * This is the STRONGEST gate in the app, because the action is irreversible data
 * deletion. It requires ALL of:
 *   1. An authenticated caller (Clerk).
 *   2. A resolvable Books tenant org from the VERIFIED token claim — the same
 *      source RLS enforces (no first-org fallback; unresolved → deny).
 *   3. The caller normalizes to `company_admin` IN THAT ORG (owner-level). Read
 *      from the identity spine (core.users → core.memberships, active) exactly
 *      like page-guard/canApprove, with the interim core.employees fallback.
 *   4. The caller is PLATFORM STAFF (core.users.is_platform_staff, or the
 *      PLATFORM_STAFF_CLERK_IDS bootstrap allowlist).
 *
 * Fails CLOSED at every branch: any absence, ambiguity, or lookup error → a 403
 * the caller MUST return immediately. It never widens access on error.
 */

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeMembershipRole } from '@/lib/rbac/role-normalize';

export interface ResetAuthority {
  clerkUserId: string;
  orgId: string;
  orgName: string;
  /** core.users.id for the caller, for audit attribution (null if unresolved). */
  coreUserId: string | null;
}

export type ResetAuthorityResult =
  | { ok: true; authority: ResetAuthority; admin: SupabaseClient }
  | { ok: false; response: NextResponse };

function forbidden(): NextResponse {
  return NextResponse.json({ error: 'Forbidden', code: 'FORBIDDEN' }, { status: 403 });
}

/** Resolve the caller's normalized role in an org, mirroring canApprove/page-guard. */
async function resolveOrgRole(
  admin: SupabaseClient,
  orgId: string,
  clerkUserId: string,
): Promise<string | null> {
  // 1. Canonical spine: core.users -> core.memberships (active).
  const { data: user, error: userErr } = await admin
    .schema('core').from('users')
    .select('id')
    .eq('clerk_user_id', clerkUserId)
    .maybeSingle();
  if (userErr) return null;

  if (user?.id) {
    const { data: membership, error: memErr } = await admin
      .schema('core').from('memberships')
      .select('role')
      .eq('user_id', user.id)
      .eq('org_id', orgId)
      .eq('status', 'active')
      .maybeSingle();
    if (memErr) return null;
    if (membership?.role) return normalizeMembershipRole(membership.role as string);
    // user exists but no active membership -> transitional fallback below.
  }

  // 2. Transitional fallback: interim core.employees.role (active rows only).
  const { data: emp, error: empErr } = await admin
    .schema('core').from('employees')
    .select('role')
    .eq('org_id', orgId)
    .eq('clerk_user_id', clerkUserId)
    .eq('is_active', true)
    .maybeSingle();
  if (empErr || !emp?.role) return null;
  return normalizeMembershipRole(emp.role as string);
}

/**
 * Resolve — and enforce — reset authority for the current request. On success it
 * returns the caller's clerk id, the resolved org (id + name), a core.users id for
 * audit, and a ready admin client. On any failure it returns a 403 the caller
 * returns immediately.
 */
export async function requireResetAuthority(): Promise<ResetAuthorityResult> {
  // Lazy imports so this module has no top-level next/headers or env dependency.
  const { requireAuth } = await import('@/lib/api-handler');
  const { createAdminSupabase } = await import('@/lib/supabase/server');
  const { resolvePlatformStaff } = await import('@/app/api/platform/_lib/platform-auth');

  // 1. Authenticated + resolved org (verified claim, no first-org fallback).
  const authRes = await requireAuth();
  if (authRes instanceof NextResponse) return { ok: false, response: forbidden() };
  const { userId: clerkUserId, orgId } = authRes;
  if (!orgId) return { ok: false, response: forbidden() };

  const admin = createAdminSupabase();

  // 2. company_admin (owner-level) IN THAT ORG.
  const role = await resolveOrgRole(admin, orgId, clerkUserId).catch(() => null);
  if (role !== 'company_admin') return { ok: false, response: forbidden() };

  // 3. Platform staff (the second, independent gate).
  const staff = await resolvePlatformStaff().catch(() => ({ isPlatformStaff: false }));
  if (!staff.isPlatformStaff) return { ok: false, response: forbidden() };

  // 4. Load org name (for the typed-confirmation match) + core.users id (audit).
  const { data: org, error: orgErr } = await admin
    .schema('core').from('organizations')
    .select('id, name')
    .eq('id', orgId)
    .maybeSingle();
  if (orgErr || !org?.id) return { ok: false, response: forbidden() };

  const { data: coreUser } = await admin
    .schema('core').from('users')
    .select('id')
    .eq('clerk_user_id', clerkUserId)
    .maybeSingle();

  return {
    ok: true,
    admin,
    authority: {
      clerkUserId,
      orgId: org.id as string,
      orgName: (org.name as string) ?? '',
      coreUserId: (coreUser?.id as string) ?? null,
    },
  };
}
