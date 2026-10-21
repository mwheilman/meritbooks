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
};

export function laborErrorCopy(e: PgErrorLike): LaborErrorCopy | null {
  const { token, detail } = splitToken(e.message);
  if (!token || !(token in LABOR_ERROR_COPY)) return null;
  const c = LABOR_ERROR_COPY[token]!;
  if (c.error) return { status: c.status, code: token, error: c.error };
  const d = detail.replace(UUID_RE, 'that record').trim();
  return {
    status: c.status,
    code: token,
    error: d ? `${d.charAt(0).toUpperCase()}${d.slice(1).replace(/\.?$/, '.')} Set the pay rate in Merit Books, or a base rate on their labor rate card.` : 'No pay rate for this time.',
  };
}
