import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createClient } from '@/lib/supabase/server';
import { ROLE_DEFINITIONS, getVisibleFeatures, getSidebarGrouped, type UserRole } from '@/lib/rbac/permissions';

export async function GET(_req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const supabase = await createClient();

    // 1. Find the org
    const { data: org } = await supabase
      .from('organizations')
      .select('id, name, setup_complete')
      .limit(1)
      .single();

    if (!org) {
      return NextResponse.json({
        authenticated: true,
        hasOrg: false,
        setupComplete: false,
        user: { clerkId: userId },
      });
    }

    // 2. Find employee record for this Clerk user
    const { data: employees } = await supabase
      .from('employees')
      .select('id, org_id, clerk_user_id, first_name, last_name, email, role, labor_type, department_id, is_active, created_at')
      .eq('clerk_user_id', userId)
      .eq('org_id', org.id)
      .limit(1);

    let employee = employees?.[0] ?? null;

    // 3. Auto-assign admin if setup is complete but no employee record exists
    if (!employee && org.setup_complete) {
      const { count } = await supabase
        .from('employees')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', org.id);

      if (count === 0 || count === null) {
        // First user after setup — auto-create as company_admin
        const { data: newEmployee, error: createErr } = await supabase
          .from('employees')
          .insert({
            org_id: org.id,
            clerk_user_id: userId,
            first_name: 'Admin',
            last_name: 'User',
            email: '',
            role: 'company_admin',
            labor_type: 'OWNER_GROUP',
            is_active: true,
          })
          .select('id, org_id, clerk_user_id, first_name, last_name, email, role, labor_type, department_id, is_active, created_at')
          .single();

        if (createErr) {
          console.error('Failed to auto-create admin:', createErr);
        } else {
          employee = newEmployee;

          // Assign to ALL locations
          const { data: locations } = await supabase
            .from('locations')
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
        .from('locations')
        .select('id, name, code')
        .eq('org_id', org.id)
        .order('name');
      locations = allLocs ?? [];

      // If portcos_and_3rdparty, filter out Merit Management
      if (roleDef.companyScope === 'portcos_and_3rdparty') {
        locations = locations.filter(
          (l) => !l.name.toLowerCase().includes('merit management') && !l.code.toLowerCase().includes('merit-mgmt')
        );
      }
    } else {
      // assigned or own_company — get from employee_locations
      const { data: assignedLocs } = await supabase
        .from('employee_locations')
        .select('location_id')
        .eq('employee_id', employee.id);

      if (assignedLocs && assignedLocs.length > 0) {
        const locIds = assignedLocs.map((al: { location_id: string }) => al.location_id);
        const { data: locs } = await supabase
          .from('locations')
          .select('id, name, code')
          .in('id', locIds)
          .order('name');
        locations = locs ?? [];
      }
    }

    // 5. Build response
    const visibleFeatures = getVisibleFeatures(role);
    const sidebarGrouped = getSidebarGrouped(role);

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
        laborType: employee.labor_type,
        isActive: employee.is_active,
        hasEmployeeRecord: true,
        mfaRequired: roleDef?.mfaRequired ?? false,
        companyScope: roleDef?.companyScope ?? 'assigned',
        payrollVisibility: roleDef?.payrollVisibility ?? 'none',
        canManageUsers: roleDef?.canManageUsers ?? false,
        canEditAccountingSettings: roleDef?.canEditAccountingSettings ?? false,
        canEditSystemSettings: roleDef?.canEditSystemSettings ?? false,
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
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { firstName, lastName, email } = body as {
      firstName?: string;
      lastName?: string;
      email?: string;
    };

    const supabase = await createClient();

    const updates: Record<string, string> = {};
    if (firstName) updates.first_name = firstName.trim();
    if (lastName) updates.last_name = lastName.trim();
    if (email) updates.email = email.trim().toLowerCase();

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    const { data: employee, error } = await supabase
      .from('employees')
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
