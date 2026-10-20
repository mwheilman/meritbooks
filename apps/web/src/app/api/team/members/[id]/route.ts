export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/server';
import { allOrgLocations } from '@/lib/team/org-locations';
import { requireManageUsers } from '@/lib/team/guard';
import { updateMemberSchema } from '@/lib/validations/team';
import { ROLE_DEFINITIONS, type UserRole } from '@/lib/rbac/permissions';
import { logHumanAction } from '@/lib/trust/action-log';
import { legacyRoleChangeSod, type LegacyRoleSodResult } from '@/lib/rbac/sod-store';
import { syncMembershipRole } from '@/lib/identity/sync-membership';
import {
  setEmployeeOnboardingCompanies,
  ensurePreparerCapability,
} from '@/lib/team/onboarding-ownership';

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

  const { role, companyIds, onboardingCompanyIds } = parsed.data;
  const effectiveRole = (role ?? target.role) as UserRole;

  // Every company referenced must belong to THIS org: the grant writes below run as the
  // service role (migration 154), so the tenant check is ours, not RLS's.
  if (!(await allOrgLocations(supabase, orgId!, [...(companyIds ?? []), ...(onboardingCompanyIds ?? [])]))) {
    return NextResponse.json(
      { error: 'One or more companies are not in this organization', code: 'INVALID_COMPANY' },
      { status: 422 }
    );
  }

  // core.employees / employee_locations / practice_assignments are SELECT-only for
  // members (migration 154): every write below runs as the service role, authorized by
  // requireManageUsers above and pinned to the session org + the org-verified target.
  const admin = createAdminSupabase();

  // Assignment-time separation of duties (05 §4.3, migration 165). A role change that
  // CREATES a hard conflict (e.g. firm tenants: edit vendor bank details + release
  // payments) is refused; new soft conflicts are returned as warnings and logged.
  let sodWarnings: LegacyRoleSodResult['warnings'] = [];
  if (role !== undefined && role !== target.role) {
    const sod = await legacyRoleChangeSod(admin, orgId!, (target.role as string | null) ?? null, role);
    if (sod.unavailable) {
      return NextResponse.json(
        { error: 'The separation-of-duties rules could not be checked right now, so the role was not changed. Try again in a moment.', code: 'SOD_UNAVAILABLE' },
        { status: 503 }
      );
    }
    if (sod.blocked.length > 0) {
      return NextResponse.json(
        {
          error: `This role would let one person ${sod.blocked[0].description.replace(/^Could /, '').replace(/\.$/, '')}. ${sod.blocked[0].suggestedFix ?? ''}`.trim(),
          code: 'SOD_CONFLICT',
          conflicts: sod.blocked.map((c) => ({ description: c.description, suggestedFix: c.suggestedFix })),
        },
        { status: 409 }
      );
    }
    sodWarnings = sod.warnings;
  }

  if (role !== undefined) {
    const { error: roleErr } = await admin
      .schema('core')
      .from('employees')
      .update({ role })
      .eq('id', memberId)
      .eq('org_id', orgId!);

    if (roleErr) {
      return NextResponse.json({ error: roleErr.message, code: 'UPDATE_ERROR' }, { status: 500 });
    }

    // Reconcile the canonical spine: push the new role onto the (user, org)
    // membership, normalized onto the same Books UserRole vocabulary canApprove
    // reads with, so the spine can never stay more permissive than the employee's
    // new role. Fail-safe (never throws) — a sync failure must not undo the role
    // change the admin just committed.
    await syncMembershipRole(orgId!, memberId, role);
  }

  if (companyIds !== undefined) {
    // Replace assignments. "All" scopes carry no per-location rows.
    const { error: delErr } = await admin
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
      const { error: insErr } = await admin.from('employee_locations').insert(rows);
      if (insErr) {
        return NextResponse.json({ error: insErr.message, code: 'UPDATE_ERROR' }, { status: 500 });
      }
    }
  }

  // Onboarding ownership — who prepares each client company's books. Recorded as
  // core.practice_assignments(function='onboarding'); replaced wholesale for this
  // member. Owning any onboarding also merges the PREPARER capability onto their
  // admin_scope. DEGRADE-SAFE: a missing table/column no-ops rather than 500s.
  if (onboardingCompanyIds !== undefined) {
    const scoped = onboardingCompanyIds.filter((id) => !companyIds || companyIds.includes(id));
    await setEmployeeOnboardingCompanies(admin, orgId!, memberId, scoped);
    if (scoped.length > 0) {
      await ensurePreparerCapability(admin, orgId!, memberId);
    }
  }

  // Trust-layer attribution (best-effort; never throws, never gates the action).
  const changes: string[] = [];
  if (role !== undefined) {
    changes.push(`role to ${ROLE_DEFINITIONS[effectiveRole]?.label ?? effectiveRole}`);
  }
  if (companyIds !== undefined) {
    changes.push(
      `company access (${companyIds.length} ${companyIds.length === 1 ? 'company' : 'companies'})`
    );
  }
  if (onboardingCompanyIds !== undefined) {
    changes.push(
      `onboarding ownership (${onboardingCompanyIds.length} ${
        onboardingCompanyIds.length === 1 ? 'company' : 'companies'
      })`
    );
  }
  await logHumanAction(supabase, userId, orgId!, {
    action: 'team.member.update',
    subjectTable: 'employees',
    subjectId: memberId,
    summary: changes.length > 0 ? `Updated ${changes.join(' and ')}` : 'Updated member',
    metadata: {
      role: role ?? null,
      companyIds: companyIds ?? null,
      sodWarnings: sodWarnings.map((w) => w.ruleKey),
    },
  });

  return NextResponse.json({
    data: {
      id: memberId,
      sodWarnings: sodWarnings.map((w) => ({ description: w.description, suggestedFix: w.suggestedFix })),
    },
  });
}
