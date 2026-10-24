/**
 * Department-owner scope (Wave 4B, AC-B17) — pure. The capability decisions are made by the
 * single policy decision point (lib/rbac/authorize.ts) in lib/budgets/access.ts; this module
 * turns them plus the caller's owned departments into what they may see and change.
 *
 *   ALL          finance staff (close_mgmt:view / their v2 equivalent) or a budget approver:
 *                every department and the company-level lines.
 *   DEPARTMENTS  everyone else (a department head): only the departments they own; company-level
 *                lines (department NULL) are not theirs.
 */
import type { BudgetAccessSummary } from './types';

export interface AccessInputs {
  userId: string;
  viewAllowed: boolean;
  editAllowed: boolean;
  approveAllowed: boolean;
  financeStaff: boolean;
  ownedDepartmentIds: readonly string[];
}

export function decideBudgetAccess(i: AccessInputs): BudgetAccessSummary {
  const all = i.financeStaff || i.approveAllowed;
  const owned = Array.from(new Set(i.ownedDepartmentIds));
  if (all) {
    return {
      scope: 'ALL',
      canView: i.viewAllowed || i.approveAllowed,
      canEdit: i.editAllowed,
      canApprove: i.approveAllowed,
      ownedDepartmentIds: owned,
      userId: i.userId,
    };
  }
  const hasDepts = owned.length > 0;
  return {
    scope: 'DEPARTMENTS',
    canView: hasDepts && (i.viewAllowed || i.editAllowed),
    canEdit: hasDepts && i.editAllowed,
    canApprove: false,
    ownedDepartmentIds: owned,
    userId: i.userId,
  };
}

/** May the caller see this department's budget (null = company-level lines)? */
export function canSeeDepartment(a: BudgetAccessSummary, departmentId: string | null): boolean {
  if (!a.canView) return false;
  if (a.scope === 'ALL') return true;
  return departmentId !== null && a.ownedDepartmentIds.includes(departmentId);
}

/** May the caller change this department's budget lines / submit it? */
export function canEditDepartment(a: BudgetAccessSummary, departmentId: string | null): boolean {
  return a.canEdit && canSeeDepartment(a, departmentId);
}

/** Keep only the rows the caller may see. */
export function filterToScope<T extends { departmentId: string | null }>(a: BudgetAccessSummary, rows: readonly T[]): T[] {
  return rows.filter((r) => canSeeDepartment(a, r.departmentId));
}

/**
 * Which departments a budget READ may return across one or more companies (H6) — pure.
 *   { departmentIds: null }     every department + company-level lines (finance / approvers everywhere)
 *   { departmentIds: [...] }    only these (the one asked for, or every department a head owns)
 *   'SCOPE'                     the department asked for isn't the caller's
 *   'FORBIDDEN'                 no budget view, or a department head who owns nothing
 * Mixed access across companies resolves to the narrower (department) scope — fail closed.
 */
export function decideReadDepartments(
  access: readonly BudgetAccessSummary[],
  departmentId: string | null,
): { departmentIds: string[] | null } | 'SCOPE' | 'FORBIDDEN' {
  if (access.length === 0 || access.some((a) => !a.canView)) return 'FORBIDDEN';
  if (departmentId !== null) return access.every((a) => canSeeDepartment(a, departmentId)) ? { departmentIds: [departmentId] } : 'SCOPE';
  if (access.every((a) => a.scope === 'ALL')) return { departmentIds: null };
  const owned = Array.from(new Set(access.flatMap((a) => a.ownedDepartmentIds)));
  return owned.length > 0 ? { departmentIds: owned } : 'FORBIDDEN';
}
