/**
 * Approval copy and small view helpers (pure, client-safe).
 */
import type { StatusKind } from '@meritbooks/merit-ui';
import type { ApprovalItem, ApprovalObjectType, DecideResult, RequestStatus, StepStatus } from './types';

export const OBJECT_LABELS: Readonly<Record<ApprovalObjectType, { one: string; many: string }>> = {
  change_order: { one: 'Change order', many: 'Change orders' },
  commitment: { one: 'Commitment', many: 'Commitments' },
  commitment_change: { one: 'Commitment change', many: 'Commitment changes' },
  billing_request: { one: 'Billing', many: 'Billing' },
  draw: { one: 'Draw', many: 'Draws' },
  time_entry: { one: 'Time', many: 'Time' },
  estimate: { one: 'Estimate below floor', many: 'Estimates below floor' },
  budget_transfer: { one: 'Budget transfer', many: 'Budget transfers' },
  dealer_deal: { one: 'Deal', many: 'Deals' },
  stage_transition: { one: 'Stage move', many: 'Stage moves' },
};

export const ROLE_TITLES: Readonly<Record<string, string>> = {
  projects_owner: 'Owner',
  projects_gm: 'General manager',
  projects_office_manager: 'Office manager',
  projects_project_accountant: 'Project accountant',
  projects_dispatcher: 'Dispatcher',
  projects_purchasing: 'Purchasing',
  projects_pm: 'Project manager',
  projects_supervisor: 'Supervisor',
  projects_labor: 'Crew',
  projects_sales: 'Sales',
  projects_payroll_admin: 'Payroll',
};

export const CONDITION_WORDS: Readonly<Record<string, string>> = {
  over_budget: 'Over budget',
  below_margin_floor: 'Below margin floor',
  overtime: 'Overtime week',
};

export function rolesLine(roles: ReadonlyArray<string>): string {
  if (roles.length === 0) return 'Anyone who can approve this';
  return roles.map((r) => ROLE_TITLES[r] ?? r).join(', ');
}

/** The row's status: pip + word (never colour alone). */
export function itemStatus(i: Pick<ApprovalItem, 'status' | 'overdue' | 'escalated' | 'can_act' | 'step' | 'step_count'>): { kind: StatusKind; word: string } {
  if (i.status === 'APPROVED') return { kind: 'ready', word: 'Approved' };
  if (i.status === 'REJECTED') return { kind: 'blocked', word: 'Sent back' };
  if (i.status === 'CANCELLED') return { kind: 'blocked', word: 'Withdrawn' };
  if (i.escalated) return { kind: 'overdue', word: 'Escalated' };
  if (i.overdue) return { kind: 'overdue', word: 'Overdue' };
  if (i.step_count > 1) return { kind: i.can_act ? 'risk' : 'track', word: `Step ${i.step} of ${i.step_count}` };
  return { kind: i.can_act ? 'risk' : 'track', word: i.can_act ? 'Needs you' : 'Waiting' };
}

export const STEP_WORDS: Readonly<Record<StepStatus, string>> = {
  WAITING: 'Not yet',
  PENDING: 'Now',
  APPROVED: 'Approved',
  REJECTED: 'Sent back',
  SKIPPED: 'Skipped',
};

export const REQUEST_WORDS: Readonly<Record<RequestStatus, string>> = {
  PENDING: 'Waiting',
  APPROVED: 'Approved',
  REJECTED: 'Sent back',
  CANCELLED: 'Withdrawn',
};

/** "Due tomorrow" / "2 days overdue" against a clock (pure). */
export function dueText(dueAt: string | null, now: Date = new Date()): string {
  if (!dueAt) return '—';
  const ms = new Date(dueAt).getTime() - now.getTime();
  const days = Math.round(ms / 86_400_000);
  if (ms < 0) {
    const late = Math.max(1, Math.round(-ms / 86_400_000));
    return late === 1 ? '1 day overdue' : `${late} days overdue`;
  }
  if (days <= 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  return `Due in ${days} days`;
}

/** The toast after a decide / act call ("Approved" vs "Sent to Owner"). */
export function decideToast(r: Pick<DecideResult, 'status' | 'waiting_on' | 'title' | 'message'>, verb = 'Approved'): string {
  switch (r.status) {
    case 'approved': return `${verb} ${r.title ?? ''}`.trim();
    case 'pending': return r.waiting_on ? `${verb} your step — now with ${r.waiting_on}` : `${verb} your step`;
    case 'submitted': return r.waiting_on ? `Sent to ${r.waiting_on} for approval` : 'Sent for approval';
    case 'rejected': return `Sent back ${r.title ?? ''}`.trim();
    case 'reopened': return r.message ?? 'It changed since it was submitted, so its approval started again';
    case 'cancelled': return r.message ?? 'No longer waiting for approval';
    default: return r.message ?? 'Done';
  }
}

export function pct(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${(Math.round(v * 1000) / 10).toFixed(1)}%`;
}
