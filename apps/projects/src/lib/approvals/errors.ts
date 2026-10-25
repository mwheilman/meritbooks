/**
 * Approval engine errors → plain HTTP responses (pure; unit-tested). The engine raises
 * "PM_TOKEN: sentence" — the sentence is written for people, so it is kept.
 */
import type { PgErrorLike } from '@/lib/api-errors';
import { splitToken } from '@/lib/api-errors';

export interface ApprovalErrorCopy {
  status: number;
  error: string;
  code: string;
}

const STATUS: Readonly<Record<string, number>> = {
  PM_SOD_VIOLATION: 403,
  PM_APPROVAL_DISTINCT: 403,
  PM_APPROVAL_NOT_YOURS: 403,
  PM_APPROVAL_REQUIRED: 409,
  PM_APPROVAL_CLOSED: 409,
  PM_APPROVAL_OPEN: 409,
  PM_APPROVAL_NOT_READY: 422,
  PM_APPROVAL_REASON: 422,
  PM_APPROVAL_SELF_REASON: 422,
  PM_APPROVAL_NO_BULK: 422,
  PM_APPROVAL_PRECONDITION: 422,
  PM_DELEGATION_SELF: 422,
  PM_DELEGATION_NO_AUTHORITY: 422,
  PM_DELEGATION_INVALID: 403,
};

const FALLBACK: Readonly<Record<string, string>> = {
  PM_SOD_VIOLATION: 'You prepared this, so someone else approves it.',
  PM_APPROVAL_REQUIRED: 'This goes through Approvals. Open it there to approve it.',
  PM_APPROVAL_REASON: 'Say why you are sending it back.',
};

function sentence(s: string): string {
  const t = s.trim().replace(/\s+/g, ' ');
  if (!t) return t;
  const cap = t[0]!.toUpperCase() + t.slice(1);
  return /[.!?]$/.test(cap) ? cap : `${cap}.`;
}

/** Known approval tokens → status + sentence; null for anything else (the caller maps it). */
export function approvalErrorCopy(err: PgErrorLike): ApprovalErrorCopy | null {
  const { token, detail } = splitToken(err.message);
  if (!token || !(token in STATUS)) return null;
  return { status: STATUS[token]!, error: detail ? sentence(detail) : FALLBACK[token] ?? 'That approval could not be recorded.', code: token };
}
