/**
 * Company (entity) scoping — the control that keeps processing work pinned to
 * exactly ONE company at a time.
 *
 * A "company" is a `core.locations` row within the caller's tenant (Merit has 17).
 * Company scope is ALWAYS a sub-filter WITHIN the tenant that RLS already isolates
 * — never a replacement for it. The selected company id is persisted in a cookie
 * (`mb_active_company`) so both the client (via useActiveCompany) and server
 * components (via next/headers cookies()) read the same value.
 *
 * This module is intentionally pure (no next/headers, no 'use client') so it is
 * safe to import from both server and client code.
 */
import type { MeUser } from '@/lib/hooks/use-me';

/** Cookie that holds the active company id (a location uuid, or ALL_COMPANIES). */
export const ACTIVE_COMPANY_COOKIE = 'mb_active_company';

/** Sentinel meaning "no single company selected" — consolidated view. */
export const ALL_COMPANIES = 'all';

/**
 * Read the active-company id from a raw cookie string (document.cookie on the
 * client, or the `cookie` request header on the server). Returns ALL_COMPANIES
 * when unset.
 */
export function readActiveCompanyCookie(cookieString: string | null | undefined): string {
  if (!cookieString) return ALL_COMPANIES;
  const match = cookieString
    .split(/;\s*/)
    .find((c) => c.startsWith(`${ACTIVE_COMPANY_COOKIE}=`));
  if (!match) return ALL_COMPANIES;
  const value = decodeURIComponent(match.slice(ACTIVE_COMPANY_COOKIE.length + 1));
  return value || ALL_COMPANIES;
}

/** True when the id names a specific company (not the consolidated sentinel). */
export function isSpecificCompany(id: string | null | undefined): id is string {
  return !!id && id !== ALL_COMPANIES;
}

/**
 * May this viewer pull CONSOLIDATED (all-company) data? Consolidation of
 * processing data is dangerous, but consolidated REPORTS are a legitimate
 * leadership need — so it is reserved for tenant leadership / admins. Everyone
 * else is per-company.
 */
export function canConsolidate(
  user: Pick<MeUser, 'role' | 'canManageUsers'> | null | undefined,
): boolean {
  if (!user) return false;
  return user.role === 'company_admin' || user.canManageUsers === true;
}
