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
 * TODO(identity FPB): the org is resolved as the "first org" and the admin
 * client bypasses RLS — this mirrors the interim pattern in /api/me and
 * apiHandler and is NOT the final tenancy story. When the Clerk-JWT org mapping
 * lands, resolve the org from the verified claim instead of limit(1). This
 * authorization LAYER is intentionally decoupled so it is ready for that change.
 */
export async function requirePermission(
  userId: string,
  featureId: string,
  action: FeatureAction
): Promise<PermissionResult> {
  // Lazy import keeps this module's top-level graph free of next/headers +
  // Supabase env access, so the pure permissionDenied() decision above stays
  // unit-testable without a DB or request context.
  const { createAdminSupabase } = await import('@/lib/supabase/server');
  const supabase = createAdminSupabase();

  // Interim org resolution — see TODO(identity FPB) above.
  const { data: org } = await supabase
    .schema('core')
    .from('organizations')
    .select('id')
    .limit(1)
    .single();

  if (!org) {
    // No org resolvable → cannot authorize → deny.
    return { ok: false, response: permissionDenied(null, featureId, action)! };
  }

  const { data: employees } = await supabase
    .schema('core')
    .from('employees')
    .select('role')
    .eq('clerk_user_id', userId)
    .eq('org_id', org.id)
    .limit(1);

  const role = (employees?.[0]?.role ?? null) as UserRole | null;

  const denied = permissionDenied(role, featureId, action);
  if (denied) return { ok: false, response: denied };

  return { ok: true, role: role as UserRole, orgId: org.id };
}
