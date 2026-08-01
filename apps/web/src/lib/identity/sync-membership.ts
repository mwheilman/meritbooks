/**
 * Membership lifecycle sync — keeps the canonical access spine
 * (`core.users` -> `core.memberships`) reconciled to the `core.employees` row
 * that admins actually edit in Team Management.
 *
 * WHY (security H1, 2026-08-01): `provisionMembershipOnLogin` mints a membership
 * ACTIVE at first login and then NEVER touches it again (insert-if-absent, never
 * syncs). So when an admin deactivates, reactivates, or role-changes an employee
 * via `/api/team/**`, the employee row moves but the membership does not — and the
 * canonical spine can drift MORE PERMISSIVE than the employee record. canApprove
 * reads the spine first, so a stale-active / stale-elevated membership could keep
 * money-approval authority a deactivated or downgraded employee should have lost.
 *
 * This module closes that gap at the SOURCE: whenever a team route successfully
 * mutates an employee, it calls one of these helpers to push the same change onto
 * the matching membership:
 *   - employee deactivated (is_active=false) -> membership status 'suspended'
 *   - employee reactivated (is_active=true)  -> membership status 'active'
 *   - employee role changed                  -> membership role updated, normalized
 *     through the SAME `normalizeMembershipRole()` the provisioning path and
 *     canApprove use, so the stored membership role stays on the canonical Books
 *     `UserRole` vocabulary the permission catalog understands (e.g. 'company_admin')
 *     — the role vocabulary can never diverge between the writer and the reader.
 *
 * RLS: `core.memberships` is service_role-write-only (migration 061 — the only
 * write policy is `service_all`), so these helpers MUST use the admin client. The
 * team routes hold an RLS-scoped request client that CANNOT write memberships;
 * that is why the sync lives here on createAdminSupabase(), exactly like
 * provision-membership.ts.
 *
 * SAFETY:
 *   - Idempotent: a plain UPDATE keyed on (user_id, org_id); re-running with the
 *     same state is a no-op. It NEVER inserts — creation stays owned by the login
 *     provisioning path. If no membership row exists yet, there is nothing on the
 *     spine to drift (canApprove's interim employees fallback governs, and it
 *     already filters is_active=true), so a no-op is correct, not a gap.
 *   - Fail-safe: never throws. A sync failure is logged and swallowed so it can
 *     never break the primary employee mutation the admin requested. The interim
 *     canApprove is_active guard remains in place as defense-in-depth precisely so
 *     a swallowed sync failure cannot reopen the H1 hole.
 *   - Fail-closed on ambiguity: on a role change whose value does NOT normalize to
 *     a known Books role, we do NOT leave the old (possibly more permissive) role
 *     standing — we SUSPEND the membership instead, so the spine can only get less
 *     permissive, never more.
 *
 * FOLLOW-UP (see canApprove H1 guard + NEEDS CENTRAL note): once this sync is
 * proven in production AND every existing approver has been backfilled with a
 * membership, the interim canApprove is_active guard and the core.employees
 * fallback can be revisited/removed. Do NOT remove them yet.
 */

import { createAdminSupabase } from '@/lib/supabase/server';
import { normalizeMembershipRole } from '@/lib/rbac/role-normalize';

/** Patch applied to the (user, org) membership row. */
type MembershipPatch =
  | { status: 'active' | 'suspended' }
  | { role: string };

/**
 * Resolve the (user, org) membership for an employee and apply a patch to it.
 * Best-effort and fail-safe: any error is logged and swallowed. Never throws.
 * Returns nothing — callers treat this as fire-and-reconcile.
 */
async function applyMembershipPatch(
  orgId: string,
  employeeId: string,
  patch: MembershipPatch,
): Promise<void> {
  try {
    const admin = createAdminSupabase();

    // 1. Resolve the employee's Clerk id (the bridge to core.users). Scoped to the
    //    org so we can never reach across tenants.
    const { data: employee, error: empErr } = await admin
      .schema('core').from('employees')
      .select('clerk_user_id')
      .eq('id', employeeId)
      .eq('org_id', orgId)
      .maybeSingle();
    if (empErr) {
      console.error('[syncMembership] employee lookup failed:', empErr.message);
      return;
    }
    const clerkUserId = employee?.clerk_user_id as string | null | undefined;
    if (!clerkUserId) return; // no Clerk identity on this employee -> no spine row to sync

    // 2. Resolve the canonical user uuid.
    const { data: user, error: userErr } = await admin
      .schema('core').from('users')
      .select('id')
      .eq('clerk_user_id', clerkUserId)
      .maybeSingle();
    if (userErr) {
      console.error('[syncMembership] user lookup failed:', userErr.message);
      return;
    }
    if (!user?.id) return; // user has never logged in -> no membership minted yet -> nothing to sync

    // 3. UPDATE-only, keyed on (user_id, org_id). Never inserts (creation is the
    //    login provisioning path's job). Idempotent: same-state update is a no-op.
    const { error: updErr } = await admin
      .schema('core').from('memberships')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('user_id', user.id)
      .eq('org_id', orgId);
    if (updErr) {
      console.error('[syncMembership] membership update failed:', updErr.message);
    }
  } catch (e) {
    console.error('[syncMembership] failed:', e instanceof Error ? e.message : e);
  }
}

/**
 * Sync membership status to mirror an employee's is_active change.
 *   deactivate (isActive=false) -> membership status 'suspended'
 *   reactivate (isActive=true)  -> membership status 'active'
 * Call AFTER the employee mutation has succeeded. Fail-safe; never throws.
 */
export async function syncMembershipActiveState(
  orgId: string,
  employeeId: string,
  isActive: boolean,
): Promise<void> {
  await applyMembershipPatch(orgId, employeeId, {
    status: isActive ? 'active' : 'suspended',
  });
}

/**
 * Sync membership role to mirror an employee's role change. `rawRole` is the value
 * written to core.employees.role; it is normalized onto the canonical Books
 * UserRole vocabulary (the SAME normalization canApprove reads with) before being
 * stored, so writer and reader can never diverge.
 *
 * FAIL-CLOSED: if the role does not normalize to a known Books role we do NOT
 * leave a stale (possibly more permissive) role on the spine — we suspend the
 * membership instead. In practice the team route constrains role to the 9 canonical
 * UserRole values via zod, so this branch is defense-in-depth.
 *
 * Call AFTER the employee role update has succeeded. Fail-safe; never throws.
 */
export async function syncMembershipRole(
  orgId: string,
  employeeId: string,
  rawRole: string,
): Promise<void> {
  const role = normalizeMembershipRole(rawRole);
  if (!role) {
    console.error(
      `[syncMembership] role "${rawRole}" did not normalize to a known Books role; ` +
        'suspending membership to fail closed rather than leaving a stale role.',
    );
    await applyMembershipPatch(orgId, employeeId, { status: 'suspended' });
    return;
  }
  await applyMembershipPatch(orgId, employeeId, { role });
}
