export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requireManageUsers } from '@/lib/team/guard';
import { updateMemberSchema } from '@/lib/validations/team';
import { ROLE_DEFINITIONS, type UserRole } from '@/lib/rbac/permissions';

function isAllCompaniesScope(role: UserRole): boolean {
  const scope = ROLE_DEFINITIONS[role]?.companyScope;
  return scope === 'all' || scope === 'portcos_and_3rdparty';
}

/**
 * PATCH /api/team/members/[id]
 * Update a member's role and/or company access. Company access is replaced
 * wholesale (delete-then-insert) so the request body is the source of truth.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId } = ctx;

  const grant = await requireManageUsers(supabase, userId, orgId);
  if (grant instanceof NextResponse) return grant;

  const memberId = params.id;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }

  const parsed = updateMemberSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  // Confirm the target lives in this org before mutating.
  const { data: target } = await supabase
    .schema('core')
    .from('employees')
    .select('id, role')
    .eq('id', memberId)
    .eq('org_id', orgId!)
    .maybeSingle();

  if (!target) {
    return NextResponse.json({ error: 'Member not found', code: 'NOT_FOUND' }, { status: 404 });
  }

  const { role, companyIds } = parsed.data;
  const effectiveRole = (role ?? target.role) as UserRole;

  if (role !== undefined) {
    const { error: roleErr } = await supabase
      .schema('core')
      .from('employees')
      .update({ role })
      .eq('id', memberId)
      .eq('org_id', orgId!);

    if (roleErr) {
      return NextResponse.json({ error: roleErr.message, code: 'UPDATE_ERROR' }, { status: 500 });
    }
  }

  if (companyIds !== undefined) {
    // Replace assignments. "All" scopes carry no per-location rows.
    const { error: delErr } = await supabase
      .from('employee_locations')
      .delete()
      .eq('employee_id', memberId)
      .eq('org_id', orgId!);

    if (delErr) {
      return NextResponse.json({ error: delErr.message, code: 'UPDATE_ERROR' }, { status: 500 });
    }

    if (companyIds.length > 0 && !isAllCompaniesScope(effectiveRole)) {
      const rows = companyIds.map((location_id) => ({
        employee_id: memberId,
        location_id,
        org_id: orgId!,
        assigned_by: grant.employeeId,
      }));
      const { error: insErr } = await supabase.from('employee_locations').insert(rows);
      if (insErr) {
        return NextResponse.json({ error: insErr.message, code: 'UPDATE_ERROR' }, { status: 500 });
      }
    }
  }

  return NextResponse.json({ data: { id: memberId } });
}
