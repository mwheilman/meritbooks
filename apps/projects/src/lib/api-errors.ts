/**
 * Postgres / PostgREST error → HTTP response, in the Merit voice. Pure (unit-tested).
 *
 *   42501            → 403  (forbidden, separation of duties, no actor)
 *   22023 / P0001    → 422  (invalid input / failed precondition) with the message
 *   P0002            → 404  (not found)
 *   23505            → 409  (duplicate)
 *   23503 / 23514    → 422  (a reference or check the data must satisfy)
 *   anything else    → 500
 *
 * Definer functions raise "PM_TOKEN: detail". The token becomes `code`; known tokens
 * get a plain sentence; unknown ones keep the database's detail.
 */

export interface PgErrorLike {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
}

export interface MappedError {
  status: number;
  body: { error: string; code: string };
}

const HUMAN: Readonly<Record<string, string>> = {
  PM_SOD_VIOLATION: 'You prepared this change order, so someone else has to approve it.',
  PM_NO_ACTOR: 'Sign in again: approvals need a named person.',
  PM_FORBIDDEN: 'That belongs to a different workspace, or you no longer have access to it.',
  PM_CO_NOT_APPROVABLE: 'Only potential or requested change orders can be approved.',
  PM_CO_TRANSITION_INVALID: 'A change order cannot move to that stage from where it is now.',
  PM_TRANSITION_NOT_ALLOWED: 'This job cannot move to that stage from its current stage.',
  PM_ALREADY_IN_STAGE: 'The job is already in that stage.',
  PM_STAGE_INACTIVE: 'That stage is no longer part of this job type. Check Settings.',
  PM_UNKNOWN_JOB_TYPE: 'That job type is not installed on this company. Check Settings.',
  PM_UNKNOWN_CUSTOMER: 'That customer was not found. Pick another or type a new name.',
  PM_NOT_A_PROJECT: 'That job is not managed in Merit Projects.',
  PM_NO_PHYSICAL_CONTRACT: 'This job’s contract tracks progress by cost, not by percent complete.',
  PM_CONTRACT_NOT_EDITABLE: 'That contract is closed or void and cannot be changed.',
  PRECONDITION_NO_CONTRACT: 'Set the contract first; progress goes to Merit Books against a contract.',
  PM_COST_CODE_SCOPE: 'That cost code belongs to another company or job.',
  PM_NO_PACK: 'Set up this company in Merit Projects first.',
  PM_INVALID: 'Check the values and try again.',
};

/** Split "PM_SOD_VIOLATION: the preparer of CO-2026-0001 cannot approve it". */
export function splitToken(message: string | null | undefined): { token: string | null; detail: string } {
  const m = /^\s*([A-Z][A-Z0-9_]{3,}):\s*(.*)$/s.exec(message ?? '');
  if (!m) return { token: null, detail: (message ?? '').trim() };
  return { token: m[1] ?? null, detail: (m[2] ?? '').trim() };
}

function sentence(token: string | null, detail: string, fallback: string): string {
  if (token && HUMAN[token]) {
    // PM_INVALID carries the specific reason ("name is required"): keep it.
    if (token === 'PM_INVALID' && detail) return capitalize(detail.replace(/\.?$/, '.'));
    return HUMAN[token] as string;
  }
  if (detail) return capitalize(detail.replace(/\.?$/, '.'));
  return fallback;
}

function capitalize(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}

export function mapPgError(err: PgErrorLike): MappedError {
  const pg = (err.code ?? '').toUpperCase();
  const { token, detail } = splitToken(err.message);
  const code = token ?? (pg || 'ERROR');
  switch (pg) {
    case '42501':
      return { status: 403, body: { error: sentence(token, '', 'You don’t have access to do that.'), code } };
    case '22023':
    case 'P0001':
      return { status: 422, body: { error: sentence(token, detail, 'Check the values and try again.'), code } };
    case 'P0002':
      return { status: 404, body: { error: sentence(token, detail, 'That was not found.'), code } };
    case '23505':
      return { status: 409, body: { error: 'That already exists. Use a different code or name.', code: token ?? 'DUPLICATE' } };
    case '23503':
    case '23514':
      return { status: 422, body: { error: sentence(token, detail, 'That change conflicts with related records.'), code } };
    case 'PGRST116':
      return { status: 404, body: { error: 'That was not found.', code: 'NOT_FOUND' } };
    default:
      return { status: 500, body: { error: 'The database did not accept that. Try again; if it repeats, tell support what you were doing.', code } };
  }
}

/** Thrown by route handlers for plain HTTP outcomes (404, 403, 422) without a PG error. */
export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly code = 'HTTP_ERROR') {
    super(message);
    this.name = 'HttpError';
  }
}

/** Thrown by query helpers; carries the PG error for mapping. */
export class PmQueryError extends Error {
  constructor(public readonly what: string, public readonly pg: PgErrorLike) {
    super(`${what}: ${pg.message ?? 'query failed'}`);
    this.name = 'PmQueryError';
  }
}
