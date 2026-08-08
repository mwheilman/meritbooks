/**
 * Server-side enforcement for the delegated-admin PREPARER capability.
 *
 * This complements the RBAC role gates (require-permission / page-guard). Those decide
 * whether the caller's ROLE may reach a surface. THIS narrows one specific class of
 * surface — the onboarding wizard + data-entry — to admins who actually hold the
 * PREPARER capability, so a MANAGEMENT-only admin is steered to delegate the books
 * rather than do the data entry themselves.
 *
 * SCOPE RESOLUTION mirrors page-guard's role resolution so the two can never disagree
 * about who a caller is: canonical spine first (core.users → core.memberships.admin_scope,
 * active), then the transitional core.employees.admin_scope fallback while memberships
 * backfill. Org resolution goes through resolveTenantOrgId (no first-org fallback).
 *
 * FAIL-OPEN, by design (see admin-scope.ts): a null/empty/absent scope, an unresolved
 * org, an unauthenticated caller, or ANY lookup error → treated as FULL access (allow).
 * The delegation distinction may only ADD a restriction for an admin EXPLICITLY marked
 * without PREPARER; it must never lock anyone out — including in the window before the
 * admin_scope migration is applied.
 */

import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  parseAdminScope,
  hasPreparerCapability,
  isMissingScopeColumn,
  type AdminCapability,
} from '@/lib/team/admin-scope';
import { resolveTenantOrgId } from '@/lib/rbac/resolve-tenant';

/**
 * Resolve the caller's admin capability set for an org, or null (= full access).
 * Canonical membership first, then the employees fallback. Any missing-column /
 * lookup error resolves to null (fail open) so the gate degrades to "allow".
 */
export async function resolveAdminScope(
  admin: SupabaseClient,
  orgId: string,
  clerkUserId: string,
): Promise<AdminCapability[] | null> {
  try {
    // 1. Canonical spine: core.users -> core.memberships.admin_scope (active).
    const { data: user } = await admin
      .schema('core')
      .from('users')
      .select('id')
      .eq('clerk_user_id', clerkUserId)
      .maybeSingle();

    if (user?.id) {
      const { data: membership, error: memErr } = await admin
        .schema('core')
        .from('memberships')
        .select('admin_scope')
        .eq('user_id', user.id)
        .eq('org_id', orgId)
        .eq('status', 'active')
        .maybeSingle();
      if (!memErr && membership) {
        return parseAdminScope((membership as { admin_scope?: unknown }).admin_scope);
      }
      // Missing column (not migrated) -> full access. Any other error -> fall through
      // to the employees fallback rather than failing closed.
      if (memErr && isMissingScopeColumn(memErr)) return null;
    }

    // 2. Transitional fallback: core.employees.admin_scope (active rows only).
    const { data: emp, error: empErr } = await admin
      .schema('core')
      .from('employees')
      .select('admin_scope')
      .eq('org_id', orgId)
      .eq('clerk_user_id', clerkUserId)
      .eq('is_active', true)
      .maybeSingle();
    if (empErr) return null; // fail OPEN (missing column or lookup error) -> full access
    return parseAdminScope((emp as { admin_scope?: unknown } | null)?.admin_scope);
  } catch {
    return null; // fail OPEN
  }
}

/**
 * Server Component guard for a PREPARER-only surface (e.g. the onboarding wizard).
 * Call AFTER the role-level requirePagePermission(...). Redirects a caller who is
 * EXPLICITLY marked without the PREPARER capability; allows everyone else. Never
 * throws except Next's redirect control-flow signal (issued outside the try).
 */
export async function requirePreparerCapabilityPage(redirectTo = '/dashboard'): Promise<void> {
  let allowed = true; // FAIL OPEN — never lock out on absence/error

  try {
    const a = await auth().catch(() => null);
    const clerkUserId = a?.userId ?? null;
    if (clerkUserId) {
      const { createAdminSupabase } = await import('@/lib/supabase/server');
      const admin = createAdminSupabase();

      const claims = (a?.sessionClaims ?? null) as Record<string, unknown> | null;
      const claimOrgId = typeof claims?.org_id === 'string' ? claims.org_id : null;
      const orgId = await resolveTenantOrgId(claimOrgId, admin);

      if (orgId) {
        const scope = await resolveAdminScope(admin, orgId, clerkUserId);
        allowed = hasPreparerCapability(scope);
      }
    }
  } catch {
    allowed = true; // fail OPEN
  }

  if (!allowed) redirect(redirectTo);
}

/**
 * Route-level guard for a PREPARER-only API action (defense in depth for the page
 * guard). Returns a 403 NextResponse when the caller is explicitly non-PREPARER, or
 * null (allow) otherwise. Fail-open on any absence/error.
 */
export async function preparerRouteDenied(
  orgId: string,
  clerkUserId: string,
): Promise<NextResponse | null> {
  try {
    const { createAdminSupabase } = await import('@/lib/supabase/server');
    const admin = createAdminSupabase();
    const scope = await resolveAdminScope(admin, orgId, clerkUserId);
    if (hasPreparerCapability(scope)) return null;
    return NextResponse.json(
      {
        error: 'This is a preparer action. Your admin access is management-only.',
        code: 'PREPARER_REQUIRED',
      },
      { status: 403 },
    );
  } catch {
    return null; // fail OPEN
  }
}
