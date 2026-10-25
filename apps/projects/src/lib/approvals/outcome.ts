/**
 * What an approve / submit response means for the person who clicked (client-safe, pure).
 * Object routes return `approval` = approvalSummary(): when the chain is not finished the object
 * is NOT approved yet — the screen says who it waits on instead of "Approved".
 */
export interface ApprovalWire {
  status: string;
  requestId?: string | null;
  waitingOn?: string | null;
  step?: number | null;
  stepCount?: number | null;
  message?: string | null;
}

function isWire(a: unknown): a is ApprovalWire {
  return typeof a === 'object' && a !== null && typeof (a as ApprovalWire).status === 'string';
}

/** True when the chain still has a step to go (the object is not approved yet). */
export function chainPending(a: unknown): boolean {
  return isWire(a) && (a.status === 'pending' || a.status === 'submitted' || a.status === 'reopened');
}

/** "Waiting on Pat Lee (step 2 of 3)". */
export function waitingText(a: ApprovalWire): string {
  const who = a.waitingOn?.trim() || 'the next approver';
  const step = a.step && a.stepCount && a.stepCount > 1 ? ` (step ${Math.min(a.step + (a.status === 'pending' ? 0 : 0), a.stepCount)} of ${a.stepCount})` : '';
  return `Waiting on ${who}${step}`;
}

/**
 * The toast after approve / submit: `done` when the chain finished (or no chain applies),
 * otherwise "<subject>: your approval is recorded · Waiting on …" (or "sent for approval").
 */
export function approvalOutcome(a: unknown, done: string, subject?: string | null): string {
  if (!isWire(a)) return done;
  if (a.status === 'rejected') return `${subject ? `${subject}: ` : ''}rejected`;
  if (a.status === 'cancelled') return `${subject ? `${subject}: ` : ''}approval request cancelled`;
  if (!chainPending(a)) return done;
  const lead = a.status === 'submitted' ? 'sent for approval' : 'your approval is recorded';
  return `${subject ? `${subject}: ` : ''}${lead} · ${waitingText(a)}`;
}

export interface TimeApprovalWire {
  approved?: number;
  pending?: number;
  sentOn?: number;
  results?: Array<{ status: string; waitingOn: string | null }>;
}

const entries = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'entry' : 'entries'}`;

/** "Approved 3 entries · 2 waiting on Pat Lee · 1 sent on to another approver". */
export function timeApprovalText(d: TimeApprovalWire | null | undefined, fallbackCount: number): string {
  if (!d) return `Approved ${entries(fallbackCount)}`;
  const approved = d.approved ?? 0;
  const pending = d.pending ?? 0;
  const sentOn = d.sentOn ?? 0;
  const who = d.results?.find((r) => (r.status === 'pending' || r.status === 'submitted') && r.waitingOn)?.waitingOn ?? null;
  const parts: string[] = [];
  if (approved || (!pending && !sentOn)) parts.push(`Approved ${entries(approved)}`);
  if (pending) parts.push(`${entries(pending)} waiting on ${who ?? 'the next approver'}`);
  if (sentOn) parts.push(`${entries(sentOn)} sent on to another approver`);
  return parts.join(' · ');
}
