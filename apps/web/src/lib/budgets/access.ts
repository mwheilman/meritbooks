/**
 * Budget access for one request (Wave 4B, AC-B17). The capability decisions go through the single
 * policy decision point (`authorize`, R-11) on `fpa.budgets`; the legacy decision each call carries
 * is the role-matrix cell the old screens used, widened by DEPARTMENT OWNERSHIP so a department head
 * on the legacy model can still build their own department:
 *
 *   view     fpa.budgets:view     legacy reports:view      OR owns a department
 *   edit     fpa.budgets:edit     legacy close_mgmt:view   OR owns a department
 *   approve  fpa.budgets:approve  legacy close_mgmt:manage
 *   finance  close_mgmt:view      (finance staff see every department and company-level lines)
 *
 * The owned departments come from public.budget_department_owners (service read, org-pinned).
 * lib/budgets/scope.ts turns these into ALL vs DEPARTMENTS scope.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { FeatureAction } from '@/lib/rbac/permissions';
import { decideBudgetAccess } from './scope';
import type { BudgetAccessSummary } from './types';

export interface AccessDeps {
  /** The R-11 decision (lib/rbac/authorize.ts `authorize`). */
  authorize: (capability: string, action: 'view' | 'edit' | 'approve', legacy: () => Promise<boolean>) => Promise<boolean>;
  /** Legacy role-matrix decision for a (feature, action) cell. */
  legacyCell: (feature: string, action: FeatureAction) => Promise<boolean>;
  /** The departments this user owns in the org. */
  ownedDepartments: () => Promise<string[]>;
}

export async function resolveBudgetAccessWith(userId: string, deps: AccessDeps): Promise<BudgetAccessSummary> {
  const owned = await deps.ownedDepartments().catch(() => [] as string[]);
  const isOwner = owned.length > 0;
  const legacy = (feature: string, action: FeatureAction, orOwner: boolean) => async () =>
    (orOwner && isOwner) || (await deps.legacyCell(feature, action).catch(() => false));
  const [viewAllowed, editAllowed, approveAllowed, financeStaff] = await Promise.all([
    deps.authorize('fpa.budgets', 'view', legacy('reports', 'view', true)).catch(() => false),
    deps.authorize('fpa.budgets', 'edit', legacy('close_mgmt', 'view', true)).catch(() => false),
    deps.authorize('fpa.budgets', 'approve', legacy('close_mgmt', 'manage', false)).catch(() => false),
    deps.legacyCell('close_mgmt', 'view').catch(() => false),
  ]);
  return decideBudgetAccess({ userId, viewAllowed, editAllowed, approveAllowed, financeStaff, ownedDepartmentIds: owned });
}

const cache = new WeakMap<SupabaseClient, Map<string, Promise<BudgetAccessSummary>>>();

/** Production wiring: authorize + role matrix + owners table. Cached per request client × company. */
export async function resolveBudgetAccess(
  ctx: { userId: string; orgId: string; supabase: SupabaseClient },
  locationId: string | null,
): Promise<BudgetAccessSummary> {
  let perClient = cache.get(ctx.supabase);
  if (!perClient) {
    perClient = new Map();
    cache.set(ctx.supabase, perClient);
  }
  const key = locationId ?? '';
  const hit = perClient.get(key);
  if (hit) return hit;
  const p = (async () => {
    const { createAdminSupabase } = await import('@/lib/supabase/server');
    const { authorize, authorizeLegacyCell } = await import('@/lib/rbac/authorize');
    const { effectivePermission } = await import('@/lib/rbac/resolve-permissions');
    const admin = createAdminSupabase();
    let rolePromise: Promise<string | null> | null = null;
    const role = () => {
      rolePromise ??= (async () => {
        const { data } = await admin.schema('core').from('employees').select('role')
          .eq('clerk_user_id', ctx.userId).eq('org_id', ctx.orgId).eq('is_active', true).limit(1);
        return ((data ?? [])[0] as { role?: string } | undefined)?.role ?? null;
      })();
      return rolePromise;
    };
    const legacyCell = async (feature: string, action: FeatureAction) => {
      const r = await role();
      return r ? effectivePermission(admin, ctx.orgId, r, feature, action) : false;
    };
    const actx = { userId: ctx.userId, orgId: ctx.orgId };
    return resolveBudgetAccessWith(ctx.userId, {
      authorize: async (capability, action, legacy) =>
        (await authorize(actx, capability, action, { locationId, legacy, route: `budgets:${action}` })).allow,
      legacyCell: async (feature, action) =>
        (await authorizeLegacyCell(actx, feature, action, { locationId, legacy: () => legacyCell(feature, action), route: `budgets:${feature}:${action}` })).allow,
      ownedDepartments: async () => {
        const { data, error } = await admin.from('budget_department_owners').select('department_id')
          .eq('org_id', ctx.orgId).eq('owner_user_id', ctx.userId);
        if (error) return [];
        return ((data ?? []) as Array<{ department_id: string }>).map((r) => r.department_id);
      },
    });
  })();
  perClient.set(key, p);
  return p;
}
