/**
 * PBC ("prepared by client") — pure, deterministic workflow logic (no I/O).
 *
 * The lifecycle of one supporting-document request an external auditor raises:
 *
 *   REQUESTED ──▶ IN_PROGRESS ──▶ PROVIDED ──▶ ACCEPTED
 *       │             │             │
 *       └──▶ WAIVED   └──▶ WAIVED   └──▶ IN_PROGRESS (sent back)
 *
 * Plus reopen paths (ACCEPTED/WAIVED → back to work). Two responsibility TIERS gate the
 * transitions, and each maps to an EXISTING permission (no invented permission — canon):
 *   - REQUESTER  → the auditor's side: create / accept / waive / reopen. Gated on
 *                  `compliance.view` (which the External Auditor role grants).
 *   - FULFILLER  → the client's side: assign, move to IN_PROGRESS / PROVIDED, attach the
 *                  fulfillment document, edit coordination fields, delete. Gated on
 *                  `compliance.manage` (which the read-only auditor role does NOT grant, so
 *                  an auditor can never fulfill their own request — a real separation).
 *
 * Everything here is pure so the state machine, the overdue rule, and the tier→permission
 * mapping are unit-tested without a DB.
 */

export const PBC_STATUSES = [
  'REQUESTED',
  'IN_PROGRESS',
  'PROVIDED',
  'ACCEPTED',
  'WAIVED',
] as const;
export type PbcStatus = (typeof PBC_STATUSES)[number];

export const PBC_STATUS_LABEL: Record<PbcStatus, string> = {
  REQUESTED: 'Requested',
  IN_PROGRESS: 'In progress',
  PROVIDED: 'Provided',
  ACCEPTED: 'Accepted',
  WAIVED: 'Waived',
};

export const PBC_CATEGORIES = [
  'BANK_REC',
  'INVOICE_SUPPORT',
  'CONTRACT',
  'PAYROLL',
  'OTHER',
] as const;
export type PbcCategory = (typeof PBC_CATEGORIES)[number];

export const PBC_CATEGORY_LABEL: Record<PbcCategory, string> = {
  BANK_REC: 'Bank reconciliation',
  INVOICE_SUPPORT: 'Invoice support',
  CONTRACT: 'Contract',
  PAYROLL: 'Payroll',
  OTHER: 'Other',
};

/** Allowed status transitions (whitelist). A transition not listed here is rejected. */
const TRANSITIONS: Record<PbcStatus, readonly PbcStatus[]> = {
  REQUESTED: ['IN_PROGRESS', 'PROVIDED', 'WAIVED'],
  IN_PROGRESS: ['PROVIDED', 'WAIVED', 'REQUESTED'],
  PROVIDED: ['ACCEPTED', 'IN_PROGRESS', 'WAIVED'],
  ACCEPTED: ['IN_PROGRESS'], // reopen
  WAIVED: ['REQUESTED'], // reinstate
};

/** Is a value one of the five PBC statuses? */
export function isPbcStatus(v: unknown): v is PbcStatus {
  return typeof v === 'string' && (PBC_STATUSES as readonly string[]).includes(v);
}

/** May the request move `from → to`? A no-op (from === to) is not a valid transition. */
export function canTransition(from: PbcStatus, to: PbcStatus): boolean {
  if (from === to) return false;
  return (TRANSITIONS[from] ?? []).includes(to);
}

/** The statuses a request may move to next (for building the UI's action set). */
export function nextStatuses(from: PbcStatus): PbcStatus[] {
  return [...(TRANSITIONS[from] ?? [])];
}

// ── Responsibility tiers → existing permissions ──────────────────────────────────
export type PbcTier = 'requester' | 'fulfiller';

/** The (feature, action) an existing guard must grant for a tier. Reuses `compliance`. */
export const TIER_PERMISSION: Record<PbcTier, { feature: 'compliance'; action: 'view' | 'manage' }> = {
  requester: { feature: 'compliance', action: 'view' },
  fulfiller: { feature: 'compliance', action: 'manage' },
};

/**
 * Which tier is responsible for moving a request INTO the given status.
 *   IN_PROGRESS / PROVIDED → the client does the work / provides the doc  (fulfiller)
 *   ACCEPTED / WAIVED / REQUESTED → the auditor accepts / waives / reopens (requester)
 */
export function tierForStatus(to: PbcStatus): PbcTier {
  return to === 'IN_PROGRESS' || to === 'PROVIDED' ? 'fulfiller' : 'requester';
}

/** The fields a PATCH may change, so the route can decide which tier it needs. */
export interface PbcUpdateIntent {
  status?: PbcStatus;
  /** Attaching/detaching the fulfillment document is a client action. */
  documentIdChange?: boolean;
  /** Assigning a responsible client user is a coordination (client) action. */
  assignedToChange?: boolean;
  /** Editing request text the auditor authored (title/description/category/period/due/notes). */
  metadataChange?: boolean;
}

/**
 * The STRONGEST tier an update requires (fulfiller > requester), or null when the update
 * changes nothing gated. The route resolves the caller's compliance caps and compares.
 */
export function requiredTierForUpdate(intent: PbcUpdateIntent): PbcTier | null {
  let needsFulfiller = false;
  let needsRequester = false;

  if (intent.status) {
    if (tierForStatus(intent.status) === 'fulfiller') needsFulfiller = true;
    else needsRequester = true;
  }
  if (intent.documentIdChange) needsFulfiller = true;
  if (intent.assignedToChange) needsFulfiller = true;
  if (intent.metadataChange) needsRequester = true;

  if (needsFulfiller) return 'fulfiller';
  if (needsRequester) return 'requester';
  return null;
}

/**
 * OVERDUE — a request with a due date in the past that the client has NOT yet fulfilled.
 * Once PROVIDED / ACCEPTED / WAIVED it is no longer overdue (the ball left the client's
 * court). Compares calendar dates in UTC so time-of-day never flips the result.
 */
export function isOverdue(
  dueDate: string | null | undefined,
  status: PbcStatus,
  now: Date = new Date(),
): boolean {
  if (!dueDate) return false;
  if (status !== 'REQUESTED' && status !== 'IN_PROGRESS') return false;
  const due = parseDateUTC(dueDate);
  if (!due) return false;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return due < today;
}

/** Whole days until due (negative = overdue by N days). Null when there's no due date. */
export function daysUntilDue(dueDate: string | null | undefined, now: Date = new Date()): number | null {
  const due = parseDateUTC(dueDate);
  if (due === null) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((due - today) / 86_400_000);
}

/** Parse a 'YYYY-MM-DD' (or ISO) date into a UTC-midnight epoch, or null when unparseable. */
function parseDateUTC(dateStr: string | null | undefined): number | null {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return Date.UTC(y, mo - 1, d);
}
