/**
 * Plain sentences for the tokens the 1108 labor / time functions raise. The shared mapper
 * (lib/api-errors) answers the codes; this gives the time-specific words (its PM_SOD_VIOLATION
 * sentence is about change orders). Pure (unit-tested).
 */
import { splitToken, type PgErrorLike } from '@/lib/api-errors';

export interface LaborErrorCopy {
  status: number;
  code: string;
  error: string;
}

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export const LABOR_ERROR_COPY: Readonly<Record<string, { status: number; error: string | null }>> = {
  PM_SOD_VIOLATION: { status: 403, error: 'Some of this time was entered by you or is your own, so someone else has to approve it.' },
  PM_TIME_NOT_SUBMITTED: { status: 422, error: 'Only submitted time can be approved. Submit the drafts first.' },
  PM_TIME_NOT_APPROVED: { status: 422, error: 'That time is not approved, so there is nothing to unapprove.' },
  PM_TIME_BILLED: { status: 422, error: 'These hours are on a billing request. Void that billing first, then unapprove.' },
  // keeps the detail (which hours, which day)
  PM_NO_LABOR_RATE: { status: 422, error: null },
  PM_RATE_CARD_NO_BASE: { status: 422, error: 'This rate card uses each employee’s own pay rate. Give it a base rate to price estimates with it.' },
  PM_UNKNOWN_RATE_CARD: { status: 404, error: 'That rate card was not found on this company.' },
  PM_RATE_CARD_SCOPE: { status: 422, error: 'That rate card belongs to another company.' },
  PM_UNKNOWN_EMPLOYEE: { status: 422, error: 'That person is not an employee of this workspace.' },
  // 1125 phone / kiosk time: the database's sentence names the hours, the day or the tap — keep it.
  PM_LATE_TAP: { status: 422, error: null },
  PM_TIME_WEEK_LOCKED: { status: 409, error: null },
  PM_PUNCH_STALE: { status: 422, error: null },
  PM_CLOCK_AHEAD: { status: 422, error: null },
  PM_PUNCH_OVERLAP: { status: 409, error: null },
};

/** When the database sends no detail for a kept-detail token. */
const LATE_FALLBACK: Readonly<Record<string, string>> = {
  PM_LATE_TAP: 'This time was entered late from the phone. Acknowledge it on the time sheet, then approve it.',
  PM_TIME_WEEK_LOCKED: 'That week already has approved time, so the late punch can’t be added. The service manager enters it on the time sheet.',
  PM_PUNCH_STALE: 'That tap is too old to send from the phone. The service manager enters it on the time sheet.',
  PM_CLOCK_AHEAD: 'The phone’s clock is ahead. Turn on automatic date and time, then try again.',
  PM_PUNCH_OVERLAP: 'A later punch is already on this person’s time. The service manager fixes the time sheet.',
};

/** "the week of Mar 3 already has approved time; the service manager enters it" → two sentences. */
function sentences(d: string): string {
  return d.split(/;\s*/).filter(Boolean).map((x) => `${x.charAt(0).toUpperCase()}${x.slice(1)}`.replace(/\.?$/, '.')).join(' ');
}

export function laborErrorCopy(e: PgErrorLike): LaborErrorCopy | null {
  const { token, detail } = splitToken(e.message);
  if (!token || !(token in LABOR_ERROR_COPY)) return null;
  const c = LABOR_ERROR_COPY[token]!;
  if (c.error) return { status: c.status, code: token, error: c.error };
  const d = detail.replace(UUID_RE, 'that record').trim();
  if (token in LATE_FALLBACK) return { status: c.status, code: token, error: d ? sentences(d) : LATE_FALLBACK[token]! };
  return {
    status: c.status,
    code: token,
    error: d ? `${d.charAt(0).toUpperCase()}${d.slice(1).replace(/\.?$/, '.')} Set the pay rate in Merit Books, or a base rate on their labor rate card.` : 'No pay rate for this time.',
  };
}
