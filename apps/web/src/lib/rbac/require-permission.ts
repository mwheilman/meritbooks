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
 * MULTI-TENANT (security HIGH-1 / identity gate #9): the org is resolved from the
 * caller's VERIFIED Clerk `org_id` claim (the same source `get_org_id()` enforces in
 * RLS) — via requireAuth(), which now returns the RESOLVED Books tenant uuid (Clerk
 * org ids are mapped; see lib/rbac/resolve-tenant.ts). There is NO first-org
 * fallback: an unresolved org fails closed (403). Authorization is evaluated against
 * the org the request actually targets, and the role is read scoped to that org and
 * normalized through the same `normalizeMembershipRole` the money-approval path
 * uses, so page/route/approval authz can't disagree.
 */
export interface RequirePermissionOptions {
  /** Client the request acts on (v2 checks the capability on that client). */
  locationId?: string | null;
  /** Wave 2C passthrough (dollar limits) — not evaluated by this guard. */
  amountCents?: number;
  /** Wave 2C passthrough (transaction SoD) — not evaluated by this guard. */
  preparedBy?: string | null;
  /** Route label for the dual-run log (defaults to the request path). */
  route?: string;
}

export async function requirePermission(
  userId: string,
  featureId: string,
  action: FeatureAction,
  opts: RequirePermissionOptions = {}
): Promise<PermissionResult> {
  // Lazy imports keep this module's top-level graph free of next/headers +
  // Supabase env access, so the pure permissionDenied() decision above stays
  // unit-testable without a DB or request context.
  const { requireAuth } = await import('@/lib/api-handler');
  const { createAdminSupabase } = await import('@/lib/supabase/server');
  const { normalizeMembershipRole } = await import('@/lib/rbac/role-normalize');

  // 1. Resolve the caller's ACTUAL org from the verified Clerk claim (RLS's source).
  //    requireAuth() returns the RESOLVED Books tenant uuid (or null). No first-org
  //    fallback: an unresolved tenant fails closed.
  const authRes = await requireAuth();
  if (authRes instanceof NextResponse) {
    // Not authenticated → cannot authorize → deny (fail closed).
    return { ok: false, response: permissionDenied(null, featureId, action)! };
  }
  const orgId: string | null = authRes.orgId;
  if (!orgId) {
    return { ok: false, response: permissionDenied(null, featureId, action)! };
  }

  const supabase = createAdminSupabase();

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

  // Custom-role-aware authorization: merge the system default for the (base) role
  // with this org's stored overrides (migration 130). For a system role with no
  // overrides this exactly equals hasPermission(normalized role); an overrides-read
  // failure degrades to the system default (fetchOverrides returns {} on error), so
  // a transient DB issue can never LOCK OUT a user who is allowed by default. Only an
  // unknown/absent role denies.
  const { effectivePermission } = await import('@/lib/rbac/resolve-permissions');
  const legacyAllowed = rawRole
    ? await effectivePermission(supabase, orgId, rawRole, featureId, action)
    : false;

  // R-11 (05-RBAC §5.1): the single policy decision point. In the tenant's 'legacy' and
  // 'dual' modes this returns legacyAllowed unchanged ('dual' also logs any v2
  // disagreement); in 'v2' the capability model decides. opts are passthroughs.
  const { authorizeLegacyCell } = await import('@/lib/rbac/authorize');
  const decision = await authorizeLegacyCell({ userId, orgId }, featureId, action, {
    legacy: async () => legacyAllowed,
    locationId: opts.locationId ?? null,
    amountCents: opts.amountCents,
    preparedBy: opts.preparedBy,
    route: opts.route,
  });
  const allowed = decision.allow;
  if (!allowed) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Forbidden', code: 'FORBIDDEN' }, { status: 403 }),
    };
  }

  // Informational only (authorization already decided above). A custom role has no
  // UserRole; fall back to the least-privileged role so no consumer mis-reads it as elevated.
  const role = (rawRole ? normalizeMembershipRole(rawRole) : null) ?? ('business_user' as UserRole);
  return { ok: true, role, orgId };
}
