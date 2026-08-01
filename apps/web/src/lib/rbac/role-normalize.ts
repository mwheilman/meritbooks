/**
 * Membership-role normalization — reconciles the Core identity vocabulary
 * (`core.memberships.role`) onto the Books permission vocabulary (`UserRole` in
 * permissions.ts).
 *
 * WHY THIS EXISTS: `core.memberships.role` is free-form text (migration 061) that
 * mirrors Clerk org roles ('owner'/'admin') and/or the identity-FPB role set
 * ('org_admin', plus the 9 merchant roles) — see docs/FPB-identity-multitenancy.md
 * §5.3. `permissions.ts` (the reserved RBAC spine) has NO 'owner'/'org_admin' key,
 * so a naive `hasPermission('owner', ...)` returns false and would silently
 * re-break money-movement approval. Every consumer of a membership role must pass
 * it through here first.
 *
 * This module is read-only against permissions.ts (it imports the catalog, never
 * edits it) so the reserved spine stays untouched.
 */

import { ALL_ROLES, type UserRole } from '@/lib/rbac/permissions';

/**
 * Membership roles that carry full org-administrator authority. All of them map
 * to the existing `company_admin` permission profile (a full approver on every
 * money surface):
 *   - 'owner'         — Clerk's default org owner (the value seen in live data)
 *   - 'admin'         — Clerk's default org admin
 *   - 'org_admin'     — the identity-FPB §5.3 name for the org administrator
 *   - 'company_admin' — already a UserRole; accepted so the membership spine can
 *                       store the Books name directly without re-breaking.
 * NOTE: Clerk's generic 'member' role is deliberately absent — a bare member has
 * no approval authority and must fail closed.
 */
const FULL_ADMIN_MEMBERSHIP_ROLES: ReadonlySet<string> = new Set([
  'owner',
  'admin',
  'org_admin',
  'company_admin',
]);

/**
 * Map a raw `core.memberships.role` value onto a Books `UserRole`, or `null` when
 * it maps to no known role. Callers MUST treat `null` as "no authority"
 * (fail closed) — never as a default-allow.
 *
 * Clerk may emit roles prefixed with `org:` ('org:owner', 'org:admin'); both the
 * bare and prefixed forms are accepted. Matching is case-insensitive.
 */
export function normalizeMembershipRole(raw: string | null | undefined): UserRole | null {
  if (!raw || typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase().replace(/^org:/, '');
  if (key === '') return null;
  if (FULL_ADMIN_MEMBERSHIP_ROLES.has(key)) return 'company_admin';
  // Otherwise the membership role must already BE one of the 9 canonical
  // UserRole values (e.g. 'accounting_specialist', 'check_processor').
  if ((ALL_ROLES as readonly string[]).includes(key)) return key as UserRole;
  // Unknown vocabulary -> no authority. Fail closed.
  return null;
}
