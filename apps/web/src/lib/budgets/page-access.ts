/**
 * Page guard for /budgets (Wave 4B, AC-B17). The budgets segment was gated on `forecast:view`,
 * which a department head doesn't hold — so the people who own department budgets couldn't open
 * them. A caller who OWNS a department budget (public.budget_department_owners, org-pinned
 * service read) may enter; everyone else falls through to the standard `forecast:view` guard,
 * which redirects to the 403 page. Inside, every API route still applies the department scope.
 */
import { auth } from '@clerk/nextjs/server';
import { requirePagePermission } from '@/lib/rbac/page-guard';

async function ownsADepartment(): Promise<boolean> {
  try {
    const a = await auth().catch(() => null);
    const userId = a?.userId ?? null;
    if (!userId) return false;
    const claims = (a?.sessionClaims ?? null) as Record<string, unknown> | null;
    const direct = typeof claims?.org_id === 'string' && claims.org_id ? claims.org_id : null;
    const native = claims?.o as { id?: unknown } | undefined;
    const raw = direct ?? (typeof native?.id === 'string' ? native.id : null);
    if (!raw) return false;
    const { createAdminSupabase } = await import('@/lib/supabase/server');
    const { resolveTenantOrgId } = await import('@/lib/rbac/resolve-tenant');
    const admin = createAdminSupabase();
    const orgId = await resolveTenantOrgId(raw, admin);
    if (!orgId) return false;
    const { data, error } = await admin.from('budget_department_owners').select('id').eq('org_id', orgId).eq('owner_user_id', userId).limit(1);
    return !error && (data ?? []).length > 0;
  } catch {
    return false; // fail closed to the standard guard
  }
}

export async function requireBudgetsPageAccess(): Promise<void> {
  if (await ownsADepartment()) return;
  await requirePagePermission('forecast', 'view');
}
