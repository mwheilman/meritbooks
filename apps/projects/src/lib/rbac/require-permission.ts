import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  hasPermission, normalizeMembershipRole,
  type FeatureAction, type ProjFeature, type UserRole,
} from '@/lib/rbac/permissions';

export type PermissionResult =
  | { ok: true; role: UserRole }
  | { ok: false; response: NextResponse };

/**
 * Pure authorization decision — no I/O, unit-testable. Returns a 403 when the
 * role is unknown/absent or lacks the (feature, action); null when permitted.
 * Fails CLOSED.
 */
export function permissionDenied(
  role: UserRole | null | undefined,
  feature: ProjFeature,
  action: FeatureAction,
): NextResponse | null {
  if (!role || !hasPermission(role, feature, action)) {
    return NextResponse.json({ error: 'Forbidden', code: 'FORBIDDEN' }, { status: 403 });
  }
  return null;
}

/**
 * Server-side permission guard for a MeritProjects route. One line inside an
 * apiHandler:
 *
 *   const guard = await requirePermission(ctx, 'proj_billing', 'approve');
 *   if (!guard.ok) return guard.response;
 *
 * The caller's role is read from `core.employees` THROUGH THE RLS-SCOPED authed
 * client (ctx.supabase). Because core.employees RLS is `org_id = get_org_id()`,
 * the lookup is inherently scoped to the org the request actually targets (the
 * same org RLS enforces on every write), and the role is normalized through the
 * same vocabulary Books uses. No service-role client, no "first org" fallback.
 * Fails closed: no active employee row → no role → deny.
 */
export async function requirePermission(
  ctx: { userId: string; supabase: SupabaseClient },
  feature: ProjFeature,
  action: FeatureAction,
): Promise<PermissionResult> {
  const { data, error } = await ctx.supabase
    .schema('core')
    .from('employees')
    .select('role')
    .eq('clerk_user_id', ctx.userId)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();

  const rawRole = !error && data ? (data as { role: string | null }).role : null;
  const role = normalizeMembershipRole(rawRole);

  const denied = permissionDenied(role, feature, action);
  if (denied) return { ok: false, response: denied };
  return { ok: true, role: role as UserRole };
}
