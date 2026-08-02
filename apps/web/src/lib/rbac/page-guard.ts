/**
 * Server-side PAGE-level RBAC guard (identity gate #9).
 *
 * Complements the route-level `requirePermission` guard: where that stops an
 * unauthorized API call, this stops an unauthorized user from ever LOADING a
 * feature's screen. It runs in a Server Component (before any client JS ships),
 * resolves the caller's role, and — when the role lacks the requested
 * (feature, action) — `redirect()`s them away instead of rendering the page.
 *
 * FAILS CLOSED. Any of: no session, no resolvable org, no role, a role that does
 * not normalize, or any lookup error → the user is redirected (never rendered).
 *
 * ROLE RESOLUTION IS INTENTIONALLY IDENTICAL TO `canApprove` (lib/money/approvals.ts)
 * so page access and money-movement authorization can never disagree about who a
 * caller is:
 *   1. CANONICAL SPINE: core.users (by clerk_user_id) -> core.memberships
 *      (by user_id + org_id + status='active') -> normalizeMembershipRole().
 *      A membership that exists but whose role does not normalize FAILS CLOSED —
 *      we do NOT fall through to a possibly-more-permissive source once the
 *      authoritative membership has spoken.
 *   2. TRANSITIONAL FALLBACK: only when NO active membership exists yet do we read
 *      the interim core.employees.role (active rows only), normalized through the
 *      SAME normalizer, so nothing regresses while memberships backfill.
 *
 * ORG RESOLUTION (identity gate #9): the org is resolved from the verified `org_id`
 * token claim via resolveTenantOrgId() (a Books uuid passes through; a Clerk org id
 * maps through core.organizations.clerk_org_id). There is NO first-org fallback — an
 * unresolved claim yields null and the page fails closed (redirect).
 */

import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { hasPermission, type FeatureAction, type UserRole } from '@/lib/rbac/permissions';
import { normalizeMembershipRole } from '@/lib/rbac/role-normalize';
import { resolveTenantOrgId } from '@/lib/rbac/resolve-tenant';

/** Where an unauthorized (but authenticated) user is bounced. Their own book of
 *  record dashboard is always visible to every internal role, so this is a safe,
 *  friendly landing spot (a 403-equivalent redirect). */
const NO_ACCESS_REDIRECT = '/dashboard';
/** Where an unauthenticated caller is bounced (defense in depth; Clerk middleware
 *  normally intercepts first). */
const SIGN_IN_REDIRECT = '/sign-in';

async function resolveOrgId(
  admin: SupabaseClient,
  claimOrgId: string | null,
): Promise<string | null> {
  // Resolve the claim to the real Books tenant (uuid passthrough OR Clerk-id mapping).
  // No first-org fallback: unresolved -> null -> fail closed.
  return resolveTenantOrgId(claimOrgId, admin);
}

/**
 * Resolve the caller's Books UserRole in an org, mirroring canApprove exactly.
 * Returns null (→ fail closed) on any absence/ambiguity/error.
 */
async function resolvePageRole(
  admin: SupabaseClient,
  orgId: string,
  clerkUserId: string,
): Promise<UserRole | null> {
  // 1. Canonical identity spine: core.users -> core.memberships (active).
  const { data: user, error: userErr } = await admin
    .schema('core')
    .from('users')
    .select('id')
    .eq('clerk_user_id', clerkUserId)
    .maybeSingle();
  if (userErr) return null; // fail closed on lookup error

  if (user?.id) {
    const { data: membership, error: memErr } = await admin
      .schema('core')
      .from('memberships')
      .select('role')
      .eq('user_id', user.id)
      .eq('org_id', orgId)
      .eq('status', 'active')
      .maybeSingle();
    if (memErr) return null; // fail closed on lookup error
    if (membership?.role) {
      // Authoritative: honor the membership decision, do NOT fall back.
      // normalizeMembershipRole returns null for unrecognized roles → fail closed.
      return normalizeMembershipRole(membership.role as string);
    }
    // user exists but no active membership in this org -> transitional fallback.
  }

  // 2. TRANSITIONAL fallback while memberships backfill: interim employees.role.
  const { data: emp, error: empErr } = await admin
    .schema('core')
    .from('employees')
    .select('role')
    .eq('org_id', orgId)
    .eq('clerk_user_id', clerkUserId)
    .eq('is_active', true)
    .maybeSingle();
  if (empErr || !emp?.role) return null; // no active role -> fail closed
  return normalizeMembershipRole(emp.role as string);
}

/**
 * Guard a Server Component page on a single (feature, action). Call it as the
 * first `await` in the page body:
 *
 *   export default async function ChecksPage() {
 *     await requirePagePermission('checks', 'view');
 *     return <ChecksClient />;
 *   }
 *
 * On success it returns (page renders). On failure it `redirect()`s and never
 * returns. Because Next's redirect() throws a control-flow signal, the decision is
 * computed inside a try/catch (fail closed) and the redirect is issued OUTSIDE it,
 * so a genuine redirect is never swallowed by the fail-closed handler.
 */
export async function requirePagePermission(
  featureId: string,
  action: FeatureAction,
): Promise<void> {
  let authenticated = false;
  let allowed = false;

  try {
    const a = await auth().catch(() => null);
    const clerkUserId = a?.userId ?? null;
    if (clerkUserId) {
      authenticated = true;
      const { createAdminSupabase } = await import('@/lib/supabase/server');
      const admin = createAdminSupabase();

      const claims = (a?.sessionClaims ?? null) as Record<string, unknown> | null;
      const claimOrgId = typeof claims?.org_id === 'string' ? claims.org_id : null;

      const orgId = await resolveOrgId(admin, claimOrgId);
      if (orgId) {
        const role = await resolvePageRole(admin, orgId, clerkUserId);
        if (role && hasPermission(role, featureId, action)) {
          allowed = true;
        }
      }
    }
  } catch {
    allowed = false; // fail closed
  }

  // Redirects live OUTSIDE the try so their control-flow throw is never caught.
  if (!authenticated) redirect(SIGN_IN_REDIRECT);
  if (!allowed) redirect(NO_ACCESS_REDIRECT);
}
