/**
 * Time approval rules the UI mirrors from pm.approve_time_entries (1108): only SUBMITTED time,
 * never time you entered or your own hours (preparer ≠ approver). Pure.
 */
export interface ApprovableEntry {
  approval_state: string;
  created_by: string | null;
  user_id: string | null;
  employee_id: string | null;
}

export type ApproveBlock = 'NOT_SUBMITTED' | 'YOURS' | null;

/** Why the caller cannot approve this entry (null = they can). */
export function approveBlock(t: ApprovableEntry, me: string, clerkOfEmployee: (employeeId: string) => string | null | undefined): ApproveBlock {
  if (t.approval_state !== 'SUBMITTED') return 'NOT_SUBMITTED';
  if (!me) return 'YOURS';
  if (t.created_by === me || t.user_id === me) return 'YOURS';
  if (t.employee_id && clerkOfEmployee(t.employee_id) === me) return 'YOURS';
  return null;
}

/** "Sent to Merit Books" appears only when a JOB_TIME event exists for the approval. */
export function sentToBooks(t: { approval_state: string; event_id: string | null }): boolean {
  return t.approval_state === 'APPROVED' && !!t.event_id;
}

/** The pinned rate as "$37.50/h" text input for the cell; null before approval. */
export function pinnedRateText(cents: number | null | undefined, fmt: (c: number) => string): string | null {
  return cents == null ? null : `${fmt(cents)}/h`;
}

export const TIME_APPROVAL_NOTE =
  'Approving pins each entry’s cost rate at pay + burden (overtime 1.5×, double time 2×) and, with Merit Books connected, sends the hours there for labor cost. You cannot approve time you entered or your own hours.';
