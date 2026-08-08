import { NextRequest, NextResponse } from 'next/server';
import { auth, currentUser } from '@clerk/nextjs/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { ROLE_DEFINITIONS, getVisibleFeatures, getSidebarGrouped, type UserRole } from '@/lib/rbac/permissions';
import { provisionMembershipOnLogin } from '@/lib/identity/provision-membership';
import { claimInvitationOnLogin } from '@/lib/identity/claim-invitation';
import { markInvitationsAcceptedByEmail } from '@/lib/team/invitations';
import { bindClerkOrgOnLogin } from '@/lib/rbac/resolve-tenant';
import { createAdminSupabase } from '@/lib/supabase/server';
import { parseAdminScope, hasPreparerCapability, hasManagementCapability, type AdminCapability } from '@/lib/team/admin-scope';

export async function GET(_req: NextRequest) {
  try {
    const ctx = await requireAuthedContext();
    if (ctx instanceof NextResponse) return ctx;
    const { supabase, orgId, userId } = ctx;

    if (!orgId) {
      return NextResponse.json({
        authenticated: true,
        hasOrg: false,
        setupComplete: false,
        user: { clerkId: userId },
      });
    }

    // 1. Find the org
    const { data: org } = await supabase
      .schema('core').from('organizations')
      .select('id, name, setup_complete')
      .eq('id', orgId)
      .single();

    if (!org) {
      return NextResponse.json({
        authenticated: true,
        hasOrg: false,
        setupComplete: false,
        user: { clerkId: userId },
      });
    }

    // 1b. Auto-bind this tenant to the caller's Clerk organization on first login, so
    //     get_org_id()/resolveTenantOrgId can map the Clerk org id -> this Books
    //     tenant on every later request (no manual id entry). Idempotent, fail-safe,
    //     and guarded (never rebinds a Clerk org to a second tenant). Uses the admin
    //     client because core.organizations.clerk_org_id is service-role-write only.
    const clerkAuth = await auth().catch(() => null);
    const clerkNativeOrgId = clerkAuth?.orgId ?? null;
    if (clerkNativeOrgId) {
      await bindClerkOrgOnLogin({
        clerkOrgId: clerkNativeOrgId,
        booksOrgId: org.id,
        admin: createAdminSupabase(),
      });
    }

    // 2. Find employee record for this Clerk user
    const { data: employees } = await supabase
      .schema('core').from('employees')
      .select('id, org_id, clerk_user_id, first_name, last_name, email, role, department_id, is_active, created_at')
      .eq('clerk_user_id', userId)
      .eq('org_id', org.id)
      .limit(1);

    let employee = employees?.[0] ?? null;

    // 2b. Invite-claim: match on the Clerk-verified primary email (case-insensitive).
    //     Two ordered paths, both keyed to that verified email so a stolen/forwarded
    //     link can never claim a seat for a different address:
    //       (i)  legacy: an admin pre-added this person as an unclaimed employee row
    //            (clerk_user_id IS NULL) — link it to the real Clerk login.
    //       (ii) invitation: a pending core.membership_invitations row — materialize
    //            the seat with its ASSIGNED role (lib/identity/claim-invitation.ts).
    //     Invitation-claim runs BEFORE the auto-admin default below, so an invited
    //     user gets their assigned role rather than falling into company_admin.
    if (!employee) {
      const clerkUser = await currentUser().catch(() => null);
      const primaryEmail =
        clerkUser?.emailAddresses?.find((e) => e.id === clerkUser.primaryEmailAddressId)?.emailAddress ??
        clerkUser?.emailAddresses?.[0]?.emailAddress ??
        null;

      if (primaryEmail) {
        const { data: claimable } = await supabase
          .schema('core').from('employees')
          .select('id, org_id, clerk_user_id, first_name, last_name, email, role, department_id, is_active, created_at')
          .eq('org_id', org.id)
          .is('clerk_user_id', null)
          .ilike('email', primaryEmail)
          .limit(1);

        const target = claimable?.[0];
        if (target) {
          const { data: linked } = await supabase
            .schema('core').from('employees')
            .update({ clerk_user_id: userId })
            .eq('id', target.id)
            .eq('org_id', org.id)
            .select('id, org_id, clerk_user_id, first_name, last_name, email, role, department_id, is_active, created_at')
            .single();
          employee = linked ?? target;
          // Tie off any matching pending invitation so it clears from the list.
          await markInvitationsAcceptedByEmail(createAdminSupabase(), org.id, primaryEmail, userId);
        } else {
          // (ii) No pre-added row — honor a pending invitation, if any. Degrade-safe:
          //      returns null when the feature isn't migrated or there is no invite.
          const claimed = await claimInvitationOnLogin({
            rls: supabase,
            admin: createAdminSupabase(),
            orgId: org.id,
            clerkUserId: userId,
            primaryEmail,
          });
          if (claimed) employee = claimed;
        }
      }
    }

    // 3. Auto-assign admin if setup is complete but no employee record exists
    if (!employee && org.setup_complete) {
      const { count } = await supabase
        .schema('core').from('employees')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', org.id);

      if (count === 0 || count === null) {
        // First user after setup — auto-create as company_admin
        const { data: newEmployee, error: createErr } = await supabase
          .schema('core').from('employees')
          .insert({
            org_id: org.id,
            clerk_user_id: userId,
            first_name: 'Admin',
            last_name: 'User',
            email: '',
            role: 'company_admin',
            is_active: true,
          })
          .select('id, org_id, clerk_user_id, first_name, last_name, email, role, department_id, is_active, created_at')
          .single();

        if (createErr) {
          console.error('Failed to auto-create admin:', createErr);
        } else {
          employee = newEmployee;

          // Assign to ALL locations
          const { data: locations } = await supabase
            .schema('core').from('locations')
            .select('id')
            .eq('org_id', org.id);

          if (locations && locations.length > 0 && employee) {
            await supabase
              .from('employee_locations')
              .insert(
                locations.map((loc: { id: string }) => ({
                  employee_id: employee!.id,
                  location_id: loc.id,
                  org_id: org.id,
                }))
              );
          }
        }
      }
    }

    if (!employee) {
      return NextResponse.json({
        authenticated: true,
        hasOrg: true,
        setupComplete: org.setup_complete,
        orgId: org.id,
        orgName: org.name,
        user: { clerkId: userId, role: null, hasEmployeeRecord: false },
      });
    }

    // 4. Get assigned locations
    const role = (employee.role || 'viewer') as UserRole;
    const roleDef = ROLE_DEFINITIONS[role];

    let locations: Array<{ id: string; name: string; code: string }> = [];
    if (roleDef?.companyScope === 'all' || roleDef?.companyScope === 'portcos_and_3rdparty') {
      const { data: allLocs } = await supabase
        .schema('core').from('locations')
        .select('id, name, code:short_code')
        .eq('org_id', org.id)
        .order('name');
      locations = allLocs ?? [];

      if (roleDef.companyScope === 'portcos_and_3rdparty') {
        locations = locations.filter(
          (l) => !l.name.toLowerCase().includes('merit management') && !l.code.toLowerCase().includes('merit-mgmt')
        );
      }
    } else {
      const { data: assignedLocs } = await supabase
        .from('employee_locations')
        .select('location_id')
        .eq('employee_id', employee.id);

      if (assignedLocs && assignedLocs.length > 0) {
        const locIds = assignedLocs.map((al: { location_id: string }) => al.location_id);
        const { data: locs } = await supabase
          .schema('core').from('locations')
          .select('id, name, code:short_code')
          .in('id', locIds)
          .order('name');
        locations = locs ?? [];
      }
    }

    // 5. Build response
    const visibleFeatures = getVisibleFeatures(role);
    const sidebarGrouped = getSidebarGrouped(role);

    // Keep the identity-layer profile (core.users) in sync with the employee
    // record, so attribution/audit shows real names. Self-provision on first
    // sign-in; update name/email thereafter (RLS: self_provision + self_update).
    await supabase
      .schema('core').from('users')
      .upsert(
        {
          clerk_user_id: userId,
          email: employee.email || null,
          first_name: employee.first_name || null,
          last_name: employee.last_name || null,
        },
        { onConflict: 'clerk_user_id' },
      );

    // Auto-provision the canonical membership so every active user has a
    // core.memberships row mirroring their access. This lets money-movement
    // authorization (canApprove) resolve on the identity spine instead of the
    // interim core.employees.role fallback. The membership role is derived from
    // (and normalized to) the employee's UserRole, so the vocabulary the
    // permission catalog understands is preserved. Idempotent + fail-safe (runs on
    // the service-role client because core.memberships is service_role-write only).
    await provisionMembershipOnLogin({
      clerkUserId: userId,
      orgId: org.id,
      employeeRole: employee.role,
      employeeId: employee.id,
    });

    // Platform-staff flag from the identity layer (core.users). Drives access to
    // the Platform plane (MeritBooks operator console) in the context switcher.
    const { data: identity } = await supabase
      .schema('core').from('users')
      .select('is_platform_staff')
      .eq('clerk_user_id', userId)
      .maybeSingle();
    const isPlatformStaff = identity?.is_platform_staff ?? false;

    // Delegated-admin responsibility (MANAGEMENT / PREPARER). Best-effort + degrade-
    // safe: a missing admin_scope column (not migrated) or any error -> null -> full
    // access (canPrepare/canManageUsersDelegated both true). This only ever ADDS a
    // restriction for an admin explicitly marked without a capability; it never
    // loosens access or locks anyone out.
    let adminScope: AdminCapability[] | null = null;
    {
      const { data: scopeRow, error: scopeErr } = await supabase
        .schema('core').from('employees')
        .select('admin_scope')
        .eq('id', employee.id)
        .maybeSingle();
      if (!scopeErr) adminScope = parseAdminScope((scopeRow as { admin_scope?: unknown } | null)?.admin_scope);
    }
    const canPrepare = hasPreparerCapability(adminScope);
    const canManageUsersDelegated = hasManagementCapability(adminScope);

    return NextResponse.json({
      authenticated: true,
      hasOrg: true,
      setupComplete: org.setup_complete,
      orgId: org.id,
      orgName: org.name,
      user: {
        clerkId: userId,
        employeeId: employee.id,
        firstName: employee.first_name,
        lastName: employee.last_name,
        email: employee.email,
        role,
        roleLabel: roleDef?.label ?? role,
        roleDescription: roleDef?.description ?? '',
        isActive: employee.is_active,
        hasEmployeeRecord: true,
        mfaRequired: roleDef?.mfaRequired ?? false,
        companyScope: roleDef?.companyScope ?? 'assigned',
        payrollVisibility: roleDef?.payrollVisibility ?? 'none',
        canManageUsers: roleDef?.canManageUsers ?? false,
        canEditAccountingSettings: roleDef?.canEditAccountingSettings ?? false,
        canEditSystemSettings: roleDef?.canEditSystemSettings ?? false,
        isPlatformStaff,
        // Delegated-admin responsibility. adminScope null = full admin (both).
        adminScope,
        canPrepare,
        canManageUsersDelegated,
      },
      permissions: {
        visibleFeatures,
        featurePermissions: roleDef?.features ?? {},
      },
      sidebar: sidebarGrouped,
      locations,
    });
  } catch (error) {
    console.error('GET /api/me error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const ctx = await requireAuthedContext();
    if (ctx instanceof NextResponse) return ctx;
    const { supabase, userId } = ctx;

    const body = await req.json();
    const { firstName, lastName, email } = body as {
      firstName?: string;
      lastName?: string;
      email?: string;
    };

    const updates: Record<string, string> = {};
    if (firstName) updates.first_name = firstName.trim();
    if (lastName) updates.last_name = lastName.trim();
    if (email) updates.email = email.trim().toLowerCase();

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    const { data: employee, error } = await supabase
      .schema('core').from('employees')
      .update(updates)
      .eq('clerk_user_id', userId)
      .select('id, first_name, last_name, email, role')
      .single();

    if (error) {
      return NextResponse.json({ error: 'Failed to update profile' }, { status: 500 });
    }

    return NextResponse.json({ success: true, employee });
  } catch (error) {
    console.error('PATCH /api/me error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
