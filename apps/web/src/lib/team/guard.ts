import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ROLE_DEFINITIONS, type UserRole } from '@/lib/rbac/permissions';

export interface ManageUsersGrant {
  ok: true;
  /** Role of the caller (already confirmed to have canManageUsers). */
  role: UserRole;
  /** core.employees.id of the caller — used as employee_locations.assigned_by. */
  employeeId: string;
}

/**
 * Team-management gate. Loads the caller's OWN employee row (by clerk_user_id +
 * org, through the RLS-scoped client) and confirms their role's
 * ROLE_DEFINITIONS[role].canManageUsers is true. Returns the caller's role +
 * employeeId, or a NextResponse (403/401) the route MUST return immediately.
 *
 * Only company_admin ships with canManageUsers: true; the check is data-driven
 * so tier/role edits stay authoritative in permissions.ts.
 */
export async function requireManageUsers(
  supabase: SupabaseClient,
  userId: string,
  orgId: string | null
): Promise<ManageUsersGrant | NextResponse> {
  if (!orgId) {
    return NextResponse.json(
      { error: 'No organization on session', code: 'NO_ORG' },
      { status: 403 }
    );
  }

  const { data: employee } = await supabase
    .schema('core')
    .from('employees')
    .select('id, role')
    .eq('clerk_user_id', userId)
    .eq('org_id', orgId)
    .maybeSingle();

  const role = (employee?.role ?? null) as UserRole | null;

  if (!employee || !role || ROLE_DEFINITIONS[role]?.canManageUsers !== true) {
    return NextResponse.json(
      { error: 'Forbidden', code: 'FORBIDDEN' },
      { status: 403 }
    );
  }

  return { ok: true, role, employeeId: employee.id as string };
}
