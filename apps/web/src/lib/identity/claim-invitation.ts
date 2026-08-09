/**
 * Invitation acceptance on first login.
 *
 * When an invited user signs up (Clerk) and hits /api/me for the first time, and no
 * core.employees row yet exists for them (neither by clerk_user_id nor a pre-added
 * unclaimed row matching their email), we look for a PENDING, non-expired invitation
 * keyed to their Clerk-verified primary email. If one exists we materialize the seat:
 *
 *   1. create the core.employees row with the invitation's ASSIGNED role (not the
 *      company_admin default), linked to this Clerk user;
 *   2. apply the invitation's per-company location grants;
 *   3. mark the invitation accepted.
 *
 * The rest of /api/me then proceeds normally: provisionMembershipOnLogin() reads the
 * new employee.role and mints the canonical core.memberships row (role normalized
 * through the same normalizeMembershipRole the whole spine uses). So an invited user
 * lands on the identical employee→membership machinery as everyone else — there is no
 * parallel role model and nothing that can't reconcile to core.memberships.
 *
 * TRUST ANCHOR: the match is on the Clerk-verified primary email, NOT the token in
 * the URL. The token is a convenience for the link and a tracking handle; email is
 * what Clerk actually proves. A stolen/forwarded link cannot claim a seat for a
 * different verified email.
 *
 * DEGRADE-SAFE + FAIL-SAFE: if core.membership_invitations doesn't exist yet (reserved
 * migration not applied), or on any error, we return null and login proceeds exactly
 * as before. Invitations are strictly additive to the existing claim path.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  INVITATIONS_SCHEMA,
  INVITATIONS_TABLE,
  isMissingInvitationsTable,
  isAllCompaniesScope,
  type InvitationRow,
} from '@/lib/team/invitations';
import { isMissingScopeColumn, parseAdminScope } from '@/lib/team/admin-scope';
import { normalizeMembershipRole } from '@/lib/rbac/role-normalize';
import type { UserRole } from '@/lib/rbac/permissions';

export interface ClaimedEmployee {
  id: string;
  org_id: string;
  clerk_user_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  role: string | null;
  department_id: string | null;
  is_active: boolean;
  created_at: string;
}

const EMPLOYEE_COLS =
  'id, org_id, clerk_user_id, first_name, last_name, email, role, department_id, is_active, created_at';

/**
 * Try to accept a pending invitation for (org, email) on first login, creating the
 * employee seat. Returns the created employee, or null when there is no claimable
 * invitation (or the feature isn't migrated yet).
 *
 * @param rls   the request-scoped (RLS) client — used to write core.employees +
 *              public.employee_locations, exactly like the auto-admin path in /api/me.
 * @param admin the service-role client — used to read/mark the invitation
 *              (core.membership_invitations is service_role-write only).
 */
export async function claimInvitationOnLogin(params: {
  rls: SupabaseClient;
  admin: SupabaseClient;
  orgId: string;
  clerkUserId: string;
  primaryEmail: string;
}): Promise<ClaimedEmployee | null> {
  const { rls, admin, orgId, clerkUserId, primaryEmail } = params;

  try {
    // 1. Find a pending, non-expired invitation for this org + verified email.
    //    Prefer the scope-bearing select; degrade to the base columns if the
    //    admin_scope column isn't migrated yet (scope then resolves to null = full).
    const BASE_INVITE_COLS =
      'id, org_id, email, role, first_name, last_name, location_ids, token, status, invited_by_clerk, expires_at, accepted_at, revoked_at, created_at';
    const findPending = (cols: string) =>
      admin
        .schema(INVITATIONS_SCHEMA)
        .from(INVITATIONS_TABLE)
        .select(cols)
        .eq('org_id', orgId)
        .eq('status', 'pending')
        .ilike('email', primaryEmail)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    let invite: InvitationRow | null = null;
    let findErr: { code?: string; message?: string } | null = null;
    const withScope = await findPending(`${BASE_INVITE_COLS}, admin_scope`);
    if (withScope.error && isMissingScopeColumn(withScope.error)) {
      const base = await findPending(BASE_INVITE_COLS);
      invite = base.data as unknown as InvitationRow | null;
      findErr = base.error;
    } else {
      invite = withScope.data as unknown as InvitationRow | null;
      findErr = withScope.error;
    }

    if (findErr) {
      if (isMissingInvitationsTable(findErr)) return null; // not migrated yet
      console.error('[claimInvitation] lookup failed:', findErr.message);
      return null;
    }
    if (!invite) return null;

    const row = invite;

    // Expired -> mark expired, do not claim.
    if (new Date(row.expires_at).getTime() < Date.now()) {
      await admin
        .schema(INVITATIONS_SCHEMA)
        .from(INVITATIONS_TABLE)
        .update({ status: 'expired', updated_at: new Date().toISOString() })
        .eq('id', row.id);
      return null;
    }

    // The invite role is constrained to the 9 Books roles at creation; normalize as a
    // belt-and-braces guard. A non-normalizing role must not mint a seat.
    const role = normalizeMembershipRole(row.role);
    if (!role) {
      console.error(`[claimInvitation] invite ${row.id} role "${row.role}" did not normalize; skipping.`);
      return null;
    }

    // 2. Create the employee seat with the ASSIGNED role, linked to this Clerk user.
    //    Carry the invitation's delegated-admin capability set onto the seat so the
    //    membership provisioning path can mirror it onto core.memberships.admin_scope.
    const empBase = {
      org_id: orgId,
      clerk_user_id: clerkUserId,
      first_name: row.first_name || '',
      last_name: row.last_name || '',
      email: (row.email || primaryEmail).toLowerCase(),
      role,
      is_active: true,
    };
    const invitedScope = parseAdminScope(row.admin_scope);

    // Degrade-safe: if core.employees.admin_scope isn't migrated yet, retry without
    // it — the seat is still created, the scope simply isn't stored until migration.
    const insertEmployee = (withScope: boolean) =>
      rls
        .schema('core')
        .from('employees')
        .insert(withScope ? { ...empBase, admin_scope: invitedScope } : empBase)
        .select(EMPLOYEE_COLS)
        .single();

    let empRes = await insertEmployee(Boolean(invitedScope));
    if (invitedScope && empRes.error && isMissingScopeColumn(empRes.error)) {
      empRes = await insertEmployee(false);
    }
    const created = empRes.data;
    const insErr = empRes.error;

    if (insErr || !created) {
      console.error('[claimInvitation] employee insert failed:', insErr?.message);
      return null;
    }

    // 3. Apply per-company grants (only for scoped roles; "all"/"portcos" see all).
    const locationIds = Array.isArray(row.location_ids) ? row.location_ids : [];
    if (locationIds.length > 0 && !isAllCompaniesScope(role as UserRole)) {
      const { error: locErr } = await rls.from('employee_locations').insert(
        locationIds.map((location_id) => ({
          employee_id: created.id as string,
          location_id,
          org_id: orgId,
        })),
      );
      if (locErr) {
        // Non-fatal: the seat exists; company access can be fixed in Team & Access.
        console.error('[claimInvitation] location grant failed:', locErr.message);
      }
    }

    // 3b. Materialize onboarding ownership (migration 121). Kept as a SEPARATE read so
    //     the new onboarding_location_ids column never couples to the main invite
    //     select — a pre-migration env simply skips this. Best-effort + non-fatal.
    try {
      const { data: ob } = await admin
        .schema(INVITATIONS_SCHEMA)
        .from(INVITATIONS_TABLE)
        .select('onboarding_location_ids')
        .eq('id', row.id)
        .maybeSingle();
      const obIds: string[] = Array.isArray((ob as { onboarding_location_ids?: unknown } | null)?.onboarding_location_ids)
        ? ((ob as { onboarding_location_ids: string[] }).onboarding_location_ids)
        : [];
      // Only companies the seat can access (all-scope roles get onboarding set from the
      // Entities board instead, so we don't infer a company list for them here).
      const scopedOb = isAllCompaniesScope(role as UserRole)
        ? []
        : obIds.filter((id) => locationIds.includes(id));
      if (scopedOb.length > 0) {
        await rls
          .schema('core')
          .from('practice_assignments')
          .upsert(
            scopedOb.map((location_id) => ({
              org_id: orgId,
              location_id,
              function: 'onboarding',
              assignee_employee_id: created.id as string,
            })),
            { onConflict: 'org_id,location_id,function' },
          );
        await rls
          .schema('core')
          .from('locations')
          .update({ onboarding_status: 'in_progress' })
          .eq('org_id', orgId)
          .in('id', scopedOb)
          .eq('onboarding_status', 'not_started');
      }
    } catch {
      // onboarding column / practice_assignments table absent — non-fatal.
    }

    // 4. Mark the invitation accepted (best-effort).
    await admin
      .schema(INVITATIONS_SCHEMA)
      .from(INVITATIONS_TABLE)
      .update({
        status: 'accepted',
        accepted_at: new Date().toISOString(),
        accepted_clerk_id: clerkUserId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', row.id);

    return created as ClaimedEmployee;
  } catch (e) {
    console.error('[claimInvitation] failed:', e instanceof Error ? e.message : e);
    return null;
  }
}
