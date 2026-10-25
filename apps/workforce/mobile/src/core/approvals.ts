/**
 * The Approve tab, phone side of the approvals engine (1113): what is waiting on me, minus what I
 * already decided on this phone (queued or sent), minus crew time the Crew section already
 * shows. Amounts only when the server says they are the approver's to see. Pure (unit-tested).
 */
import type { ApprovalDecideCommand, ApprovalItem } from './contract';
import type { QueuedCommand } from './queue';

export type ApprovalFlag = 'overdue' | 'escalated' | 'overtime' | 'over_budget' | 'below_margin_floor' | 'self';

const KEPT = new Set(['pending', 'sending', 'done']);

/** Request ids decided on this phone (still waiting, sending, or accepted by the office). */
export function decidedHere(queued: ReadonlyArray<QueuedCommand>): Map<string, ApprovalDecideCommand['decision']> {
  const m = new Map<string, ApprovalDecideCommand['decision']>();
  for (const q of queued) if (q.command.kind === 'approval.decide' && KEPT.has(q.status)) m.set(q.command.requestId, q.command.decision);
  return m;
}

/** Decisions the office refused, with the reason (shown on the tab until cleared). */
export function refusedHere(queued: ReadonlyArray<QueuedCommand>): Array<{ id: string; requestId: string; reason: string }> {
  return queued
    .filter((q) => q.command.kind === 'approval.decide' && q.status === 'rejected')
    .map((q) => ({ id: q.id, requestId: (q.command as ApprovalDecideCommand).requestId, reason: q.result?.reason ?? q.lastError ?? '' }));
}

/**
 * The items I can act on now. Time entries already listed under Crew time are left there (one
 * place to approve each), and anything decided on this phone disappears at once.
 */
export function actionable(items: ReadonlyArray<ApprovalItem>, queued: ReadonlyArray<QueuedCommand>, crewEntryIds: ReadonlySet<string>): ApprovalItem[] {
  const done = decidedHere(queued);
  return items
    .filter((i) => i.status === 'PENDING' && i.can_act && !done.has(i.id))
    .filter((i) => !(i.object_type === 'time_entry' && crewEntryIds.has(i.object_id)))
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.due_at ?? '9').localeCompare(b.due_at ?? '9') || a.submitted_at.localeCompare(b.submitted_at));
}

export function flagsOf(i: ApprovalItem): ApprovalFlag[] {
  const f: ApprovalFlag[] = [];
  if (i.overdue) f.push('overdue');
  if (i.escalated) f.push('escalated');
  if (i.facts?.overtime) f.push('overtime');
  if (i.facts?.over_budget) f.push('over_budget');
  if (i.facts?.below_margin_floor) f.push('below_margin_floor');
  if (i.self_approval) f.push('self');
  return f;
}

/** The amount to show, or null: only when the engine says the money is mine to see. */
export function shownAmount(i: ApprovalItem): number | null {
  return i.money_visible && typeof i.amount_cents === 'number' ? i.amount_cents : null;
}

/** Sending back always needs a reason; approving needs one when the company asks or it is my own item. */
export function needsReason(i: ApprovalItem, decision: 'approve' | 'reject'): boolean {
  return decision === 'reject' || i.needs_reason || i.self_approval;
}

/** The draft the Approve tab queues: round and step pinned to what this phone saw. */
export function decisionDraft(i: ApprovalItem, decision: 'approve' | 'reject', reason: string | null): Omit<ApprovalDecideCommand, 'id' | 'at' | 'tz' | 'geo' | 'offline'> {
  const r = reason?.trim() || null;
  return {
    kind: 'approval.decide', requestId: i.id, decision, round: i.round, step: i.step,
    reason: decision === 'reject' || !i.self_approval ? r : null,
    selfReason: decision === 'approve' && i.self_approval ? r : null,
  };
}

export function isApprovalInbox(v: unknown): v is { items: ApprovalItem[]; counts: { mine: number; mine_overdue: number; waiting: number } } {
  return typeof v === 'object' && v !== null && Array.isArray((v as { items?: unknown }).items) && typeof (v as { counts?: unknown }).counts === 'object';
}
