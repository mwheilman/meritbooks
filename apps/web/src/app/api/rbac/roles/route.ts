export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requireManageUsers } from '@/lib/team/guard';
import { ALL_ROLES, ROLE_DEFINITIONS } from '@/lib/rbac/permissions';
import { buildCatalogPayload } from '@/lib/rbac/permission-catalog';

/**
 * GET /api/rbac/roles
 *
 * Admin-only. Lists every role a caller can inspect/customize — the 9 SYSTEM roles
 * (shipped defaults) plus this org's CUSTOM roles — together with the feature/action
 * catalog and its plain-English glossary that the admin UI renders. The per-role
 * effective matrix (defaults merged with overrides) is fetched separately from
 * /api/rbac/roles/[roleKey].
 *
 * Gated with requireManageUsers (the existing canManageUsers admin check) — no new
 * permission key is invented. Fails closed (403) for non-admins.
 */
export async function GET(_req: NextRequest) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId } = ctx;

  const grant = await requireManageUsers(supabase, userId, orgId);
  if (grant instanceof NextResponse) return grant;

  // System roles (metadata only; per-cell grants come from the matrix endpoint).
  const systemRoles = ALL_ROLES.map((key) => {
    const def = ROLE_DEFINITIONS[key];
    return {
      key,
      label: def.label,
      description: def.description,
      isCustom: false,
      baseRole: key,
      companyScope: def.companyScope,
      payrollVisibility: def.payrollVisibility,
      mfaRequired: def.mfaRequired,
      canManageUsers: def.canManageUsers,
      canEditAccountingSettings: def.canEditAccountingSettings,
      canEditSystemSettings: def.canEditSystemSettings,
    };
  });

  // Custom roles for this org (RLS-scoped read; org filter is belt-and-suspenders).
  const { data: custom, error } = await supabase
    .schema('core')
    .from('custom_roles')
    .select('key, name, description, base_role, created_at')
    .eq('org_id', orgId!)
    .order('created_at', { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
  }

  const customRoles = (custom ?? []).map(
    (r: { key: string; name: string; description: string | null; base_role: string | null }) => ({
      key: r.key,
      label: r.name,
      description: r.description ?? '',
      isCustom: true,
      baseRole: r.base_role,
      // A custom role's scope/flags follow its base role (or the safe default when none).
      companyScope: r.base_role ? ROLE_DEFINITIONS[r.base_role as keyof typeof ROLE_DEFINITIONS]?.companyScope ?? 'assigned' : 'assigned',
    }),
  );

  return NextResponse.json({
    data: {
      systemRoles,
      customRoles,
      catalog: buildCatalogPayload(),
    },
  });
}
