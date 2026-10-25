/**
 * Plain sentences for the tokens migration 1117 raises. 53400 (capacity) and 23505 (duplicate open
 * job) would otherwise map to a generic 500 / "already exists". Pure (unit-tested).
 */
import { splitToken, type PgErrorLike } from '@/lib/api-errors';

export interface FsErrorCopy {
  status: number;
  code: string;
  error: string;
}

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function tidy(detail: string): string {
  const s = detail.replace(UUID_RE, 'that record').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/\.?$/, '.') : '';
}

const FIXED: Readonly<Record<string, { status: number; text: string }>> = {
  PM_FS_UNKNOWN_JOB_TYPE: { status: 422, text: 'Pick a job type this company books.' },
  PM_FS_UNKNOWN_BU: { status: 422, text: 'Pick the business unit for this call.' },
  PM_FS_UNKNOWN_WINDOW: { status: 422, text: 'Pick an arrival window.' },
  PM_FS_NO_JOB_TYPE: { status: 422, text: 'This company has no job type to book into yet. Apply a pack in Settings first.' },
  PM_FS_NOT_A_REQUEST: { status: 422, text: 'That request was already handled.' },
  PM_FS_CALL_CLOSED: { status: 422, text: 'That call is already closed.' },
  PM_FS_NOT_BOOKED: { status: 422, text: 'This visit was not booked through Calls, so it has no business unit to check capacity against.' },
  PM_FS_ESTIMATE_LOCKED: { status: 409, text: 'These options were already sold or declined.' },
  PM_FS_UNKNOWN_TEMPLATE: { status: 422, text: 'Pick a membership plan this company sells.' },
  PM_FS_COMPANY_MISMATCH: { status: 422, text: 'That setting belongs to another company.' },
  FS_WIDGET_UNKNOWN: { status: 404, text: 'This booking link is not active. Please call us.' },
  FS_WIDGET_BUSY: { status: 429, text: 'Online booking is busy right now. Please call us.' },
  FS_WIDGET_KEY: { status: 403, text: 'Online booking is unavailable right now. Please call us.' },
  FS_WIDGET_NOT_SET_UP: { status: 503, text: 'Online booking isn’t set up yet. Please call us.' },
};

/** Tokens whose detail is already a plain sentence for the person. */
const DETAIL: Readonly<Record<string, number>> = {
  PM_FS_CAPACITY_FULL: 409,
  PM_FS_DUPLICATE_OPEN_JOB: 409,
  PM_FS_DO_NOT_SERVICE: 422,
  PM_FS_WINDOW_CLOSED: 422,
  PM_FS_WINDOW_PAST: 422,
  PM_FS_TECH_UNAVAILABLE: 409,
  PM_FS_WARRANTY_REGISTRATION: 422,
  PM_FS_NO_VISIT: 422,
  FS_WIDGET_INVALID: 422,
  FS_WIDGET_TOO_SOON: 422,
  FS_WIDGET_LIMIT: 429,
};

export function fsErrorCopy(e: PgErrorLike): FsErrorCopy | null {
  const { token, detail } = splitToken(e.message);
  if (!token) {
    if (e.code === '53400') return { status: 409, code: 'PM_FS_CAPACITY_FULL', error: 'That window is full.' };
    return null;
  }
  const fixed = FIXED[token];
  if (fixed) return { status: fixed.status, code: token, error: fixed.text };
  const st = DETAIL[token];
  if (st) return { status: st, code: token, error: tidy(detail) || 'That could not be booked.' };
  return null;
}
