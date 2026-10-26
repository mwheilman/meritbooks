/**
 * Budget lifecycle rules (Wave 4B) — the app-side mirror of migration 189's triggers, so a route
 * refuses an illegal move with a clear message BEFORE the database does (the database stays the
 * guarantor). Pure; docs/FPB-reports-fpna.md §4.11, AC-B9…B11.
 */
import type { BoardStatus, PlanStatus, VersionKind, VersionStatus } from './types';

export type BudgetErrorCode = 'LOCKED' | 'SOD' | 'NOT_FOUND' | 'SCOPE' | 'VALIDATION' | 'CONFLICT' | 'PERIOD_CLOSED';

export class BudgetError extends Error {
  constructor(public readonly code: BudgetErrorCode, message: string) {
    super(message);
    this.name = 'BudgetError';
  }
  get status(): number {
    switch (this.code) {
      case 'NOT_FOUND': return 404;
      case 'SCOPE': return 403;
      case 'VALIDATION': return 422;
      default: return 409;
    }
  }
}

export function isBudgetError(e: unknown): e is BudgetError {
  return e instanceof BudgetError;
}

/** Map a Postgres error from 189's triggers / CHECKs to a BudgetError (else null). */
export function budgetErrorFromDb(message: string | null | undefined): BudgetError | null {
  if (!message) return null;
  // Checked first: the closed-period trigger's message may also carry other prefixes.
  const closed = /BUDGET_PERIOD_CLOSED:?\s*(.*)$/.exec(message);
  if (closed) {
    const detail = closed[1].trim();
    return new BudgetError('PERIOD_CLOSED', detail ? capitalize(detail) : 'That month is closed — budgets for a closed month can’t change.');
  }
  const locked = /BUDGET_LOCKED:\s*(.+)$/.exec(message);
  if (locked) return new BudgetError('LOCKED', capitalize(locked[1].trim()));
  const sod = /BUDGET_SOD:\s*(.+)$/.exec(message);
  if (sod) return new BudgetError('SOD', capitalize(sod[1].trim()));
  if (/budget_plan_versions_chk|budget_department_plans_chk/.test(message) && /approved_by|violates check/.test(message)) {
    return new BudgetError('SOD', 'The person who submitted a budget can’t approve it.');
  }
  if (/budget_comments_chk/.test(message)) return new BudgetError('VALIDATION', 'That comment is missing required details, or the reviewer is its author.');
  if (/uq_budget_plan_versions_current/.test(message)) return new BudgetError('CONFLICT', 'Another version is already the current budget for that year.');
  if (/uq_budget_plan_versions_number/.test(message)) return new BudgetError('CONFLICT', 'That version number already exists — reload and try again.');
  return null;
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export type VersionAction = 'submit' | 'return' | 'approve' | 'lock' | 'delete';

const VERSION_MOVES: Record<VersionAction, { from: readonly VersionStatus[]; to: VersionStatus | null }> = {
  submit: { from: ['DRAFT'], to: 'IN_REVIEW' },
  return: { from: ['IN_REVIEW'], to: 'DRAFT' },
  approve: { from: ['IN_REVIEW'], to: 'APPROVED' },
  lock: { from: ['APPROVED'], to: 'LOCKED' },
  delete: { from: ['DRAFT'], to: null },
};

export interface VersionActionInput {
  action: VersionAction;
  status: VersionStatus;
  kind: VersionKind;
  actor: string;
  submittedBy: string | null;
  /** Who created the version — the maker of record when no submitter was recorded. */
  createdBy?: string | null;
  /** Plans in the version that are not APPROVED (approve needs zero). */
  openPlans: number;
  /** The company-year's current BUDGET version is LOCKED (and is not this one). */
  currentIsLockedOther: boolean;
  isCurrent: boolean;
  note?: string | null;
}

/** Throws BudgetError when the move is illegal; returns the target status (null = delete). */
export function checkVersionAction(i: VersionActionInput): VersionStatus | null {
  const move = VERSION_MOVES[i.action];
  if (!move.from.includes(i.status)) {
    const verb = { submit: 'submit', return: 'return', approve: 'approve', lock: 'lock', delete: 'delete' }[i.action];
    throw new BudgetError('LOCKED', `You can’t ${verb} a version that is ${statusWord(i.status)}.`);
  }
  if (i.action === 'approve') {
    // Segregation of duties is never skipped: the maker is the submitter, else the creator; with
    // no maker on record at all the approval is refused (fail closed).
    const maker = i.submittedBy ?? i.createdBy ?? null;
    if (!maker) throw new BudgetError('SOD', 'No submitter is recorded for this version — submit it for approval first.');
    if (maker === i.actor) {
      throw new BudgetError('SOD', 'The person who submitted a budget can’t approve it.');
    }
    if (i.openPlans > 0) {
      throw new BudgetError('LOCKED', `${i.openPlans} department budget${i.openPlans === 1 ? ' is' : 's are'} not approved yet.`);
    }
    if (i.kind === 'BUDGET' && i.currentIsLockedOther) {
      throw new BudgetError('LOCKED', 'This year’s budget is locked — changes go into a reforecast.');
    }
  }
  if (i.action === 'return' && !(i.note && i.note.trim().length >= 3)) {
    throw new BudgetError('VALIDATION', 'Say what needs to change (at least 3 characters).');
  }
  if (i.action === 'submit' && i.openPlans > 0) {
    throw new BudgetError('LOCKED', `${i.openPlans} department budget${i.openPlans === 1 ? ' is' : 's are'} not approved yet — approve or remove them first.`);
  }
  if (i.action === 'lock' && i.kind === 'BUDGET' && !i.isCurrent) {
    throw new BudgetError('LOCKED', 'Only the current budget can be locked.');
  }
  return move.to;
}

export type PlanAction = 'submit' | 'return' | 'approve' | 'reopen';

export interface PlanActionInput {
  action: PlanAction;
  status: PlanStatus;
  versionStatus: VersionStatus;
  actor: string;
  submittedBy: string | null;
  note?: string | null;
  /** Expense plan minus target (cents); null = no target. */
  expenseGapCents?: number | null;
  gapNote?: string | null;
}

export function checkPlanAction(i: PlanActionInput): PlanStatus {
  if (i.versionStatus !== 'DRAFT') {
    throw new BudgetError('LOCKED', `Department budgets can’t change once the version is ${statusWord(i.versionStatus)}.`);
  }
  switch (i.action) {
    case 'submit':
      if (!['NOT_STARTED', 'DRAFT', 'RETURNED'].includes(i.status)) throw new BudgetError('LOCKED', `This department budget is already ${planWord(i.status)}.`);
      return 'SUBMITTED';
    case 'return':
      if (i.status !== 'SUBMITTED') throw new BudgetError('LOCKED', 'Only a submitted department budget can be returned.');
      if (!(i.note && i.note.trim().length >= 3)) throw new BudgetError('VALIDATION', 'Say what needs to change (at least 3 characters).');
      return 'RETURNED';
    case 'approve':
      // Approve only what was submitted (maker → checker), and never by the submitter.
      if (i.status !== 'SUBMITTED') {
        throw new BudgetError('LOCKED', i.status === 'APPROVED' ? 'This department budget is already approved.' : 'Only a submitted department budget can be approved — submit it first.');
      }
      if (!i.submittedBy) throw new BudgetError('SOD', 'No submitter is recorded for this department budget — submit it again.');
      if (i.submittedBy === i.actor) {
        throw new BudgetError('SOD', 'You submitted this department budget — someone else has to approve it.');
      }
      if (i.expenseGapCents != null && i.expenseGapCents !== 0 && !(i.gapNote && i.gapNote.trim().length >= 3)) {
        throw new BudgetError('VALIDATION', 'The plan is off its target — add a note explaining the gap before approving.');
      }
      return 'APPROVED';
    case 'reopen':
      if (i.status !== 'APPROVED' && i.status !== 'SUBMITTED') throw new BudgetError('LOCKED', 'Only a submitted or approved department budget can be reopened.');
      return 'DRAFT';
  }
}

/**
 * A department's status on the submission board.
 *  - It has a plan row → that plan's status.
 *  - No plan row, version still a DRAFT → 'NOT_STARTED' (the department can start; its first
 *    save creates the plan, and from then on the approval gate counts it).
 *  - No plan row, version past draft (in review / approved / locked / superseded) → the
 *    department never had a budget of its own in this version: 'NO_REVIEW' when the version
 *    carries lines for it anyway (e.g. migrated in), else 'NOT_IN_VERSION'. Showing "Not
 *    started" next to an approved budget would claim a review step that was never required.
 */
export function boardStatus(plan: PlanStatus | null, versionStatus: VersionStatus, hasLines: boolean): BoardStatus {
  if (plan) return plan;
  if (versionStatus === 'DRAFT') return 'NOT_STARTED';
  return hasLines ? 'NO_REVIEW' : 'NOT_IN_VERSION';
}

/**
 * Department budgets that block submitting / approving a version: every plan not APPROVED, plus
 * every department that carries lines in the version but has no plan at all (its numbers would
 * otherwise be published without department review). Company-level lines (no department) don't
 * count — finance owns those and approves them with the version.
 */
export function openDepartmentCount(
  plans: ReadonlyArray<{ departmentId: string; status: PlanStatus }>,
  lineDepartmentIds: Iterable<string | null>,
): number {
  const planned = new Set(plans.map((p) => p.departmentId));
  let open = plans.filter((p) => p.status !== 'APPROVED').length;
  const seen = new Set<string>();
  for (const d of lineDepartmentIds) {
    if (!d || planned.has(d) || seen.has(d)) continue;
    seen.add(d);
    open++;
  }
  return open;
}

/** Why a grid is read-only (null = editable). */
export function lockReason(versionStatus: VersionStatus, planStatus: PlanStatus | null, canEdit: boolean): string | null {
  if (versionStatus !== 'DRAFT') {
    return versionStatus === 'IN_REVIEW'
      ? 'This version is in review. Return it to draft to change it.'
      : `This version is ${statusWord(versionStatus)}. Create a new version to change it.`;
  }
  if (planStatus === 'SUBMITTED') return 'This department budget is submitted. It can be changed after it is returned.';
  if (planStatus === 'APPROVED') return 'This department budget is approved. Reopen it to change it.';
  if (!canEdit) return 'You can view this budget but not change it.';
  return null;
}

export function statusWord(s: VersionStatus): string {
  return { DRAFT: 'a draft', IN_REVIEW: 'in review', APPROVED: 'approved', LOCKED: 'locked', SUPERSEDED: 'superseded' }[s];
}

function planWord(s: PlanStatus): string {
  return { NOT_STARTED: 'not started', DRAFT: 'in draft', SUBMITTED: 'submitted', RETURNED: 'returned', APPROVED: 'approved' }[s];
}

/** Next version number for a company × FY × kind. */
export function nextVersionNumber(existing: ReadonlyArray<{ kind: VersionKind; versionNumber: number }>, kind: VersionKind): number {
  return existing.filter((v) => v.kind === kind).reduce((m, v) => Math.max(m, v.versionNumber), 0) + 1;
}

export function defaultLabel(fiscalYear: number, kind: VersionKind, n: number): string {
  return kind === 'BUDGET' ? `FY${fiscalYear} Budget v${n}` : `FY${fiscalYear} Reforecast ${n}`;
}
