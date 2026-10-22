/**
 * can(access, cap, action, companyId?) — pure and client-safe (works on a deserialized Access too).
 *
 *   companyId given → the grant must be held AT that company (location scope, spec §1.5).
 *   companyId omitted → held at ANY company the caller is assigned to (menus, workspace views).
 *
 * The database is the authority (RLS + pm.can in definer RPCs); this decides what the app shows
 * and which routes it lets through first.
 */
import type { Access, AccessAction, Grant, ProjectCapability } from './types';

export function can(access: Access, cap: ProjectCapability, action: AccessAction, companyId?: string | null): boolean {
  const g: Grant = `${cap}:${action}`;
  if (companyId) return access.byCompany[companyId]?.has(g) ?? false;
  return access.grants.has(g);
}

/** Companies where the caller holds cap:action. */
export function companiesWith(access: Access, cap: ProjectCapability, action: AccessAction): string[] {
  const g: Grant = `${cap}:${action}`;
  return Object.entries(access.byCompany).filter(([, s]) => s.has(g)).map(([id]) => id);
}

/** Money visibility shorthands (spec §2.1 tags). */
export const canSeeCost = (a: Access, companyId?: string | null): boolean => can(a, 'projects.financials', 'view', companyId);
export const canSeeContract = (a: Access, companyId?: string | null): boolean => can(a, 'projects.contract_value', 'view', companyId);
export const canSeeRates = (a: Access, companyId?: string | null): boolean => can(a, 'projects.labor_rates', 'view', companyId);
