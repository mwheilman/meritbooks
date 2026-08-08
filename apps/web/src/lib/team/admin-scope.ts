/**
 * Delegated-admin responsibility model ("admin scope").
 *
 * Owner requirement (2026-08-08): the tenant/org admin often does NOT do the
 * bookkeeping — they delegate it. So when a company_admin adds another admin they
 * choose that admin's RESPONSIBILITY. This is modeled as a CAPABILITY SET, not a
 * mutually-exclusive role, so a person can hold one or both:
 *
 *   - MANAGEMENT — invites/manages users and oversees, but does NOT run the
 *     onboarding wizard / data entry themselves (they delegate that to preparers).
 *   - PREPARER   — runs the onboarding wizard and does the books.
 *
 * It rides ALONGSIDE the existing RBAC role (permissions.ts) — it never replaces or
 * loosens it. A company_admin is still a company_admin for every permission check;
 * admin_scope only ADDS a PREPARER gate on the onboarding/data-entry surfaces so a
 * MANAGEMENT-only admin is steered to delegate rather than do the data entry.
 *
 * DEGRADE-SAFE / FAIL-OPEN (deliberate, and the OPPOSITE of the role gate): the
 * backing column (core.membership_invitations.admin_scope / core.employees.admin_scope
 * / core.memberships.admin_scope — REPORTED to the lead as a reserved migration) may
 * not exist yet. When the scope is ABSENT / NULL / EMPTY we treat the admin as having
 * BOTH capabilities — i.e. today's behavior, full access, NO lockout. Only an
 * EXPLICIT scope that omits a capability restricts anything. This guarantees the
 * feature can only ever ADD the delegation distinction, never take access away from
 * an existing user or lock anyone out before the migration lands.
 */

import { ROLE_DEFINITIONS, type UserRole } from '@/lib/rbac/permissions';

/** The DB column that stores the capability set on every carrier row. */
export const ADMIN_SCOPE_COLUMN = 'admin_scope' as const;

export type AdminCapability = 'MANAGEMENT' | 'PREPARER';

export const ADMIN_CAPABILITIES: readonly AdminCapability[] = ['MANAGEMENT', 'PREPARER'] as const;

/**
 * Is this the "column does not exist / not in schema cache" error? That is the ONLY
 * error we swallow into the degrade-safe "column absent → full access" path; every
 * other error is a real failure the caller must handle. PostgREST reports an unknown
 * column as PGRST204 (schema cache); raw Postgres reports 42703 (undefined_column).
 */
export function isMissingScopeColumn(
  error: { code?: string; message?: string } | null | undefined,
): boolean {
  if (!error) return false;
  const code = 'code' in error ? error.code : undefined;
  if (code === '42703' || code === 'PGRST204' || code === 'PGRST205') return true;
  const msg = ('message' in error ? error.message : '') ?? '';
  return /could not find the .*column|column .* does not exist|schema cache/i.test(msg);
}

/**
 * Coerce a raw DB value (Postgres text[] → JS string[], or null/undefined) into a
 * clean, de-duplicated, validated capability list — or NULL when there is nothing
 * meaningful to enforce. NULL is the degrade-safe "full access" signal, so an empty
 * array collapses to null on purpose (an admin with no explicit capabilities is a
 * FULL admin, never a locked-out one).
 */
export function parseAdminScope(raw: unknown): AdminCapability[] | null {
  if (!Array.isArray(raw)) return null;
  const caps: AdminCapability[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const up = v.trim().toUpperCase();
    if ((ADMIN_CAPABILITIES as readonly string[]).includes(up) && !caps.includes(up as AdminCapability)) {
      caps.push(up as AdminCapability);
    }
  }
  return caps.length > 0 ? caps : null;
}

/**
 * Normalize a caller-supplied capability selection for STORAGE. Returns:
 *   - null  → store nothing (unrestricted / full admin — today's behavior)
 *   - [..]  → an explicit, restricting capability set
 * Both capabilities selected collapses to null so a full admin is stored as the
 * unrestricted default rather than an explicit set (keeps the roster clean and the
 * gate a no-op). An empty/invalid selection also collapses to null (fail open).
 */
export function normalizeAdminScopeForStorage(
  input: readonly string[] | null | undefined,
): AdminCapability[] | null {
  const parsed = parseAdminScope(input as unknown);
  if (!parsed) return null;
  // Holding every capability == unrestricted; store as the default (null).
  if (ADMIN_CAPABILITIES.every((c) => parsed.includes(c))) return null;
  return parsed;
}

/**
 * Can this admin RUN the onboarding wizard / data-entry surfaces?
 * FAIL-OPEN: null/empty scope → true (full access, no lockout). Only an explicit
 * scope that omits PREPARER returns false.
 */
export function hasPreparerCapability(scope: AdminCapability[] | null | undefined): boolean {
  if (!scope || scope.length === 0) return true;
  return scope.includes('PREPARER');
}

/**
 * Can this admin invite/manage users? FAIL-OPEN like above. (Retained for symmetry
 * and future management-surface gating; the RBAC role's canManageUsers still governs
 * whether the surface exists at all — this only narrows a role that already has it.)
 */
export function hasManagementCapability(scope: AdminCapability[] | null | undefined): boolean {
  if (!scope || scope.length === 0) return true;
  return scope.includes('MANAGEMENT');
}

/**
 * Which roles get the MANAGEMENT-vs-PREPARER delegation choice at invite time?
 * The "admin" the owner means is one who can invite/manage users — i.e. a role whose
 * ROLE_DEFINITIONS[...].canManageUsers is true (today: company_admin). For every
 * other role the distinction is moot (they don't manage users), so the picker is
 * hidden and their scope stays unrestricted (governed by their own RBAC role).
 */
export function isAdminLevelRole(role: UserRole): boolean {
  return ROLE_DEFINITIONS[role]?.canManageUsers === true;
}

/** Human label for a capability (UI). */
export function adminCapabilityLabel(cap: AdminCapability): string {
  return cap === 'MANAGEMENT' ? 'Management' : 'Preparer';
}

/**
 * A short roster/summary label for a scope: null → 'Full admin', a single cap → its
 * label, both → 'Full admin'. Used to show each member's delegated responsibility.
 */
export function adminScopeSummary(scope: AdminCapability[] | null | undefined): string {
  if (!scope || scope.length === 0) return 'Full admin';
  if (ADMIN_CAPABILITIES.every((c) => scope.includes(c))) return 'Full admin';
  return scope.map(adminCapabilityLabel).join(' + ');
}
