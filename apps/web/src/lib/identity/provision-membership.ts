/**
 * Membership auto-provisioning on login.
 *
 * WHY: the canonical access spine is `core.users` -> `core.memberships`
 * (migration 061; suite identity/access contract, docs/canon/10-suite-contracts-digest.md
 * FILE 4). Money-movement authorization (`lib/money/approvals.ts` canApprove) resolves
 * the caller on that spine and only falls back to the interim `core.employees.role`
 * source when NO active membership exists yet. Today most existing users have an
 * employee row but no membership, so the fallback fires for them.
 *
 * This helper closes that gap: on every successful `/api/me` resolution, once the
 * user's `core.users` row is ensured, it materializes an ACTIVE `core.memberships`
 * row for (user, org) if none exists — deriving the role from that org's
 * `core.employees.role` and normalizing it through the SAME
 * `normalizeMembershipRole()` that canApprove reads with, so the stored membership
 * role is a canonical Books `UserRole` the permission catalog understands (e.g.
 * `company_admin`) rather than a Clerk value like `owner`. With the membership in
 * place, canApprove's canonical path resolves and the employees fallback stops
 * firing for that user.
 *
 * RLS: `core.memberships` / `core.membership_locations` accept writes from
 * `service_role` only (migration 061 has no self-insert policy), so this MUST run
 * on the admin (service-role) client — the RLS-scoped request client cannot insert
 * a membership. That is why provisioning lives here and uses createAdminSupabase()
 * rather than the route's request-scoped supabase.
 *
 * SAFETY: idempotent (insert-if-absent via ON CONFLICT (user_id, org_id) DO
 * NOTHING — never duplicates, never overwrites an existing/hand-elevated or
 * intentionally suspended membership) and NEVER throws (provisioning must not break
 * login). It also never writes a bogus membership: an unrecognized / absent
 * employee role normalizes to null and we skip rather than granting a made-up role.
 */

import { createAdminSupabase } from '@/lib/supabase/server';
import { normalizeMembershipRole } from '@/lib/rbac/role-normalize';
import { isMissingScopeColumn, parseAdminScope } from '@/lib/team/admin-scope';

interface ProvisionParams {
  /** Clerk `user_xxx` id of the signed-in caller. */
  clerkUserId: string;
  /** MeritBooks tenant org uuid (core.organizations.id). */
  orgId: string;
  /** The caller's `core.employees.role` for THIS org (UserRole vocabulary), if any. */
  employeeRole: string | null | undefined;
  /** The caller's `core.employees.id` for THIS org — used only to mirror location scope. */
  employeeId?: string | null;
}

/**
 * Ensure an active `core.memberships` row mirrors this user's access for the org.
 * Best-effort and fail-safe: any error is logged and swallowed so login proceeds.
 *
 * PRECONDITION: the caller's `core.users` row must already be ensured (the /api/me
 * route upserts it before calling this). If the users row is somehow absent we skip
 * — we never invent identity here.
 */
export async function provisionMembershipOnLogin(params: ProvisionParams): Promise<void> {
  const { clerkUserId, orgId, employeeRole, employeeId } = params;

  try {
    // Derive the membership role from the employee role, normalized onto the
    // canonical Books UserRole vocabulary — the SAME normalization canApprove
    // applies on read, so authority is guaranteed consistent. An absent or
    // unrecognized role (e.g. null, or the display-default 'viewer' which is not a
    // real UserRole) -> null -> skip. We never provision a fabricated role.
    const role = normalizeMembershipRole(employeeRole ?? null);
    if (!role) return;

    const admin = createAdminSupabase();

    // Resolve the canonical user uuid. (Route ensured the row already; this just
    // reads it back so we key the membership on user_id, not clerk text.)
    const { data: user, error: userErr } = await admin
      .schema('core').from('users')
      .select('id')
      .eq('clerk_user_id', clerkUserId)
      .maybeSingle();
    if (userErr || !user?.id) return; // no identity row -> nothing to attach a membership to

    // Mirror the employee's delegated-admin capability set onto the membership so the
    // canonical spine carries the responsibility (MANAGEMENT / PREPARER) the invite
    // assigned. Best-effort + degrade-safe: if core.employees.admin_scope isn't
    // migrated we read nothing and provision exactly as before.
    let adminScope: string[] | null = null;
    if (employeeId) {
      const { data: emp, error: scopeErr } = await admin
        .schema('core').from('employees')
        .select('admin_scope')
        .eq('id', employeeId)
        .eq('org_id', orgId)
        .maybeSingle();
      if (!scopeErr) adminScope = parseAdminScope((emp as { admin_scope?: unknown } | null)?.admin_scope);
    }

    // Insert-if-absent. ON CONFLICT (user_id, org_id) DO NOTHING via
    // ignoreDuplicates: idempotent, never duplicates, and — critically — never
    // overwrites an existing membership (a hand-elevated role, or a deliberately
    // 'suspended'/'invited' status stays untouched; we do NOT silently reactivate).
    const membershipRow = { user_id: user.id, org_id: orgId, role, status: 'active' as const };
    let upsertErr: { code?: string; message?: string } | null = null;
    if (adminScope) {
      // Degrade-safe: retry without admin_scope if the column isn't migrated yet, so
      // membership provisioning (which money-approval authz depends on) never breaks.
      ({ error: upsertErr } = await admin
        .schema('core').from('memberships')
        .upsert(
          { ...membershipRow, admin_scope: adminScope },
          { onConflict: 'user_id,org_id', ignoreDuplicates: true },
        ));
      if (upsertErr && isMissingScopeColumn(upsertErr)) {
        ({ error: upsertErr } = await admin
          .schema('core').from('memberships')
          .upsert(membershipRow, { onConflict: 'user_id,org_id', ignoreDuplicates: true }));
      }
    } else {
      ({ error: upsertErr } = await admin
        .schema('core').from('memberships')
        .upsert(membershipRow, { onConflict: 'user_id,org_id', ignoreDuplicates: true }));
    }
    if (upsertErr) {
      console.error('[provisionMembershipOnLogin] membership upsert failed:', upsertErr.message);
      return;
    }

    // Best-effort location mirror: copy the employee's explicit location grants
    // (employee_locations) into membership_locations. Also idempotent (unique
    // (membership_id, location_id), ignoreDuplicates). For 'all'-scope roles
    // employee_locations is typically empty and the membership role's scope
    // governs instead — so an empty mirror is correct, not a gap. Any failure is
    // swallowed; it never blocks login.
    if (employeeId) {
      const { data: membership } = await admin
        .schema('core').from('memberships')
        .select('id')
        .eq('user_id', user.id)
        .eq('org_id', orgId)
        .maybeSingle();

      if (membership?.id) {
        const { data: empLocs } = await admin
          .from('employee_locations')
          .select('location_id')
          .eq('employee_id', employeeId)
          .eq('org_id', orgId);

        if (empLocs && empLocs.length > 0) {
          await admin
            .schema('core').from('membership_locations')
            .upsert(
              empLocs.map((l: { location_id: string }) => ({
                membership_id: membership.id,
                location_id: l.location_id,
              })),
              { onConflict: 'membership_id,location_id', ignoreDuplicates: true },
            );
        }
      }
    }
  } catch (e) {
    console.error('[provisionMembershipOnLogin] failed:', e instanceof Error ? e.message : e);
  }
}
