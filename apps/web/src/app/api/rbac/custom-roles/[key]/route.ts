export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requireManageUsers } from '@/lib/team/guard';
import { ALL_ROLES } from '@/lib/rbac/permissions';
import { logHumanAction } from '@/lib/trust/action-log';

/**
 * DELETE /api/rbac/custom-roles/[key]
 *
 * Admin-only. Delete a CUSTOM role and its permission overrides. Refuses to delete a
 * system role key. Refuses (409) while any active member still holds the role, so no one
 * is silently orphaned into a deny-all identity — reassign them first. Fails closed for
 * non-admins.
 */
export async function DELETE(_req: NextRequest, { params }: { params: { key: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId } = ctx;

  const grant = await requireManageUsers(supabase, userId, orgId);
  if (grant instanceof NextResponse) return grant;

  const key = decodeURIComponent(params.key ?? '').trim();
  if (!key) {
    return NextResponse.json({ error: 'Missing role key', code: 'BAD_REQUEST' }, { status: 400 });
  }
  if ((ALL_ROLES as readonly string[]).includes(key)) {
    return NextResponse.json(
      { error: 'System roles cannot be deleted', code: 'SYSTEM_ROLE' },
      { status: 400 },
    );
  }

  // Confirm the custom role exists in this org before doing anything.
  const { data: role, error: roleErr } = await supabase
    .schema('core')
    .from('custom_roles')
    .select('key, name')
    .eq('org_id', orgId!)
    .eq('key', key)
    .maybeSingle();
  if (roleErr) {
    return NextResponse.json({ error: roleErr.message, code: 'QUERY_ERROR' }, { status: 500 });
  }
  if (!role) {
    return NextResponse.json({ error: 'Role not found', code: 'NOT_FOUND' }, { status: 404 });
  }

  // Block deletion while any active member holds the role (avoid orphaning into deny-all).
  const { count: inUse } = await supabase
    .schema('core')
    .from('employees')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId!)
    .eq('role', key)
    .eq('is_active', true);
  if ((inUse ?? 0) > 0) {
    return NextResponse.json(
      {
        error: `Reassign the ${inUse} member(s) with this role before deleting it.`,
        code: 'ROLE_IN_USE',
      },
      { status: 409 },
    );
  }

  // Remove overrides first, then the role. Both are org-scoped (RLS + explicit filter).
  const { error: ovErr } = await supabase
    .schema('core')
    .from('role_permission_overrides')
    .delete()
    .eq('org_id', orgId!)
    .eq('role_key', key);
  if (ovErr) {
    return NextResponse.json({ error: ovErr.message, code: 'DELETE_ERROR' }, { status: 500 });
  }

  const { error: delErr } = await supabase
    .schema('core')
    .from('custom_roles')
    .delete()
    .eq('org_id', orgId!)
    .eq('key', key);
  if (delErr) {
    return NextResponse.json({ error: delErr.message, code: 'DELETE_ERROR' }, { status: 500 });
  }

  await logHumanAction(supabase, userId, orgId!, {
    action: 'rbac.custom_role.delete',
    subjectTable: 'custom_roles',
    subjectId: key,
    summary: `Deleted custom role "${role.name}"`,
    metadata: { key },
  });

  return NextResponse.json({ data: { key } });
}
