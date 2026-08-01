import { NextResponse } from 'next/server';
import { hasPermission, type FeatureAction, type UserRole } from '@/lib/rbac/permissions';

export type PermissionResult =
  | { ok: true; role: UserRole; orgId: string }
  | { ok: false; response: NextResponse };

/**
 * Pure authorization decision — no I/O, unit-testable.
 *
 * Returns a 403 Forbidden response when the role is unknown/absent or lacks the
 * requested (feature, action); returns null when the action is permitted. Fails
 * CLOSED: an unrecognized role is treated as having no permissions.
 */
export function permissionDenied(
  role: UserRole | null | undefined,
  featureId: string,
  action: FeatureAction
): NextResponse | null {
  if (!role || !hasPermission(role, featureId, action)) {
    return NextResponse.json(
      { error: 'Forbidden', code: 'FORBIDDEN' },
      { status: 403 }
    );
  }
  return null;
}

/**
 * Reusable server-side permission guard. Resolves the caller's role from their
 * employee record and authorizes a single (feature, action). A route guards
 * itself in one line:
 *
 *   const guard = await requirePermission(userId, 'journal_entries', 'post');
 *   if (!guard.ok) return guard.response;
 *
 * Use this AFTER requireAuth() has established the userId. It relies on the same
 * role model as /api/me (packages: lib/rbac/permissions.ts) — do not invent a
 * parallel model.
 *
 * MULTI-TENANT (security HIGH-1 / identity gate #9, fixed 2026-08-01): the org is
 * now resolved from the caller's VERIFIED Clerk `org_id` claim (the same source
 * `get_org_id()` enforces in RLS) — NOT "first org". So authorization is evaluated
 * against the org the request actually targets. "First org" survives only as a
 * transitional fallback for the window before the org_id claim is provisioned; it
 * is removed once every tenant's JWT carries the claim. The role is read scoped to
 * that org and normalized through the same `normalizeMembershipRole` the money-
 * approval path uses, so page/route/approval authz can't disagree.
 */
export async function requirePermission(
  userId: string,
  featureId: string,
  action: FeatureAction
): Promise<PermissionResult> {
  // Lazy imports keep this module's top-level graph free of next/headers +
  // Supabase env access, so the pure permissionDenied() decision above stays
  // unit-testable without a DB or request context.
  const { requireAuth } = await import('@/lib/api-handler');
  const { createAdminSupabase } = await import('@/lib/supabase/server');
  const { normalizeMembershipRole } = await import('@/lib/rbac/role-normalize');

  // 1. Resolve the caller's ACTUAL org from the verified Clerk claim (RLS's source).
  const authRes = await requireAuth();
  if (authRes instanceof NextResponse) {
    // Not authenticated → cannot authorize → deny (fail closed).
    return { ok: false, response: permissionDenied(null, featureId, action)! };
  }
  let orgId: string | null = authRes.orgId;

  const supabase = createAdminSupabase();

  // Transitional fallback ONLY when the claim hasn't been provisioned yet.
  if (!orgId) {
    const { data: org } = await supabase
      .schema('core')
      .from('organizations')
      .select('id')
      .limit(1)
      .single();
    orgId = (org as { id: string } | null)?.id ?? null;
  }
  if (!orgId) {
    return { ok: false, response: permissionDenied(null, featureId, action)! };
  }

  // 2. Read the caller's role SCOPED TO THAT ORG, normalized to the canonical
  //    UserRole vocabulary (so 'owner'/'org_admin' reconcile like canApprove).
  const { data: employees } = await supabase
    .schema('core')
    .from('employees')
    .select('role')
    .eq('clerk_user_id', userId)
    .eq('org_id', orgId)
    .eq('is_active', true)
    .limit(1);

  const rawRole = (employees?.[0]?.role ?? null) as string | null;
  const role = rawRole ? normalizeMembershipRole(rawRole) : null;

  const denied = permissionDenied(role, featureId, action);
  if (denied) return { ok: false, response: denied };

  return { ok: true, role: role as UserRole, orgId };
}
