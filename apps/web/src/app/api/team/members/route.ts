export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requireManageUsers } from '@/lib/team/guard';
import { createMemberSchema } from '@/lib/validations/team';
import { ROLE_DEFINITIONS, type UserRole } from '@/lib/rbac/permissions';
import { logHumanAction } from '@/lib/trust/action-log';

interface MemberCompany {
  id: string;
  name: string;
}

/** A role whose companies are the entire org (no per-location assignment). */
function isAllCompaniesScope(role: UserRole): boolean {
  const scope = ROLE_DEFINITIONS[role]?.companyScope;
  return scope === 'all' || scope === 'portcos_and_3rdparty';
}

/**
 * GET /api/team/members
 * Admin-only roster with role + company access, for the Team & Access surface.
 */
export async function GET(_req: NextRequest) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId } = ctx;

  const grant = await requireManageUsers(supabase, userId, orgId);
  if (grant instanceof NextResponse) return grant;

  // Every employee in the org.
  const { data: employees, error: empErr } = await supabase
    .schema('core')
    .from('employees')
    .select('id, first_name, last_name, email, role, is_active, clerk_user_id')
    .eq('org_id', orgId!)
    .order('last_name')
    .order('first_name');

  if (empErr) {
    return NextResponse.json({ error: empErr.message, code: 'QUERY_ERROR' }, { status: 500 });
  }

  // All org locations (companies) — used for name resolution + "all" scopes.
  const { data: locations, error: locErr } = await supabase
    .schema('core')
    .from('locations')
    .select('id, name')
    .eq('org_id', orgId!)
    .order('name');

  if (locErr) {
    return NextResponse.json({ error: locErr.message, code: 'QUERY_ERROR' }, { status: 500 });
  }

  const allCompanies: MemberCompany[] = (locations ?? []).map((l: { id: string; name: string }) => ({
    id: l.id,
    name: l.name,
  }));
  const companyById = new Map(allCompanies.map((c) => [c.id, c]));

  // Per-employee location assignments (public.employee_locations).
  const { data: assignments, error: assignErr } = await supabase
    .from('employee_locations')
    .select('employee_id, location_id')
    .eq('org_id', orgId!);

  if (assignErr) {
    return NextResponse.json({ error: assignErr.message, code: 'QUERY_ERROR' }, { status: 500 });
  }

  const assignedByEmployee = new Map<string, string[]>();
  for (const a of (assignments ?? []) as Array<{ employee_id: string; location_id: string }>) {
    const list = assignedByEmployee.get(a.employee_id) ?? [];
    list.push(a.location_id);
    assignedByEmployee.set(a.employee_id, list);
  }

  const members = (employees ?? []).map((e: Record<string, unknown>) => {
    const role = (e.role ?? 'accounting_specialist') as UserRole;
    const roleDef = ROLE_DEFINITIONS[role];
    const companyScope = roleDef?.companyScope ?? 'assigned';

    let companies: MemberCompany[];
    if (isAllCompaniesScope(role)) {
      companies = allCompanies;
    } else {
      const ids = assignedByEmployee.get(e.id as string) ?? [];
      companies = ids
        .map((id) => companyById.get(id))
        .filter((c): c is MemberCompany => Boolean(c));
    }

    return {
      id: e.id as string,
      firstName: (e.first_name as string) ?? '',
      lastName: (e.last_name as string) ?? '',
      email: (e.email as string) ?? null,
      role,
      roleLabel: roleDef?.label ?? role,
      isActive: e.is_active === true,
      clerkLinked: e.clerk_user_id != null,
      companyScope,
      companies,
    };
  });

  return NextResponse.json({
    data: members,
    summary: {
      total: members.length,
      active: members.filter((m) => m.isActive).length,
      invited: members.filter((m) => m.isActive && !m.clerkLinked).length,
    },
  });
}

/**
 * POST /api/team/members
 * Add a member (unlinked employee row) and grant company access.
 */
export async function POST(req: NextRequest) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId } = ctx;

  const grant = await requireManageUsers(supabase, userId, orgId);
  if (grant instanceof NextResponse) return grant;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }

  const parsed = createMemberSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const { email, firstName, lastName, role, companyIds } = parsed.data;
  const normalizedEmail = email.trim().toLowerCase();

  // Reject a duplicate email within the org (case-insensitive).
  const { data: existing } = await supabase
    .schema('core')
    .from('employees')
    .select('id')
    .eq('org_id', orgId!)
    .ilike('email', normalizedEmail)
    .limit(1);

  if (existing && existing.length > 0) {
    return NextResponse.json(
      { error: 'A member with that email already exists', code: 'DUPLICATE_EMAIL' },
      { status: 409 }
    );
  }

  const { data: created, error: insertErr } = await supabase
    .schema('core')
    .from('employees')
    .insert({
      org_id: orgId!,
      clerk_user_id: null,
      first_name: firstName?.trim() || '',
      last_name: lastName?.trim() || '',
      email: normalizedEmail,
      role,
      is_active: true,
    })
    .select('id, first_name, last_name, email, role, is_active, clerk_user_id')
    .single();

  if (insertErr || !created) {
    return NextResponse.json(
      { error: insertErr?.message ?? 'Failed to create member', code: 'INSERT_ERROR' },
      { status: 500 }
    );
  }

  // Only per-location roles get explicit company grants; "all" scopes see
  // everything without rows in employee_locations.
  if (companyIds.length > 0 && !isAllCompaniesScope(role)) {
    const rows = companyIds.map((location_id) => ({
      employee_id: created.id as string,
      location_id,
      org_id: orgId!,
      assigned_by: grant.employeeId,
    }));
    const { error: linkErr } = await supabase.from('employee_locations').insert(rows);
    if (linkErr) {
      return NextResponse.json(
        { error: `Member created but company access failed: ${linkErr.message}`, code: 'LINK_ERROR' },
        { status: 500 }
      );
    }
  }

  // Trust-layer attribution (best-effort; never throws, never gates the action).
  const roleLabel = ROLE_DEFINITIONS[role]?.label ?? role;
  await logHumanAction(supabase, userId, orgId!, {
    action: 'team.member.add',
    subjectTable: 'employees',
    subjectId: created.id as string,
    summary: `Added ${normalizedEmail} as ${roleLabel}`,
    metadata: { role, companyIds },
  });

  return NextResponse.json({ data: { id: created.id } }, { status: 201 });
}
