/**
 * Dealer service errors → HTTP. Every route maps errors through `dealerErrorResponse`
 * so D2 sees one consistent shape: { error, code, details? } with a meaningful status.
 */

import { NextResponse } from 'next/server';
import { PostingError } from '@/lib/posting/account-roles';
import { DealerEngineError } from '../types';

export type DealerErrorCode =
  | 'NO_ORG'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'NOT_ENABLED'
  | 'CONFLICT'
  | 'VALIDATION'
  | 'UNMAPPED_ROLE'
  | 'UNMAPPED_DEPARTMENT'
  | 'NOT_FOOTING'
  | 'INTEREST_VARIANCE'
  | 'SEPARATION_OF_DUTIES'
  | 'ENABLE_BLOCKED'
  | 'POSTING_FAILED'
  | 'DB_ERROR';

const STATUS: Record<DealerErrorCode, number> = {
  NO_ORG: 403,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  NOT_ENABLED: 409,
  CONFLICT: 409,
  VALIDATION: 422,
  UNMAPPED_ROLE: 422,
  UNMAPPED_DEPARTMENT: 422,
  NOT_FOOTING: 422,
  INTEREST_VARIANCE: 409,
  SEPARATION_OF_DUTIES: 403,
  ENABLE_BLOCKED: 409,
  POSTING_FAILED: 422,
  DB_ERROR: 500,
};

export class DealerError extends Error {
  readonly code: DealerErrorCode;
  readonly status: number;
  readonly details?: unknown;
  constructor(code: DealerErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'DealerError';
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

/** Throw a DB_ERROR for a PostgREST error (never swallow). */
export function dbFail(what: string, error: { message: string } | null | undefined): never {
  throw new DealerError('DB_ERROR', `${what}: ${error?.message ?? 'unknown error'}`);
}

export function dealerErrorResponse(e: unknown): NextResponse {
  if (e instanceof DealerError) {
    return NextResponse.json(
      { error: e.message, code: e.code, ...(e.details !== undefined ? { details: e.details } : {}) },
      { status: e.status },
    );
  }
  if (e instanceof DealerEngineError || e instanceof PostingError) {
    return NextResponse.json({ error: e.message, code: 'VALIDATION' }, { status: 422 });
  }
  const msg = e instanceof Error ? e.message : 'Internal server error';
  // A DB constraint (CHECK / unique / trigger) is a business refusal, not a crash.
  if (/violates check constraint|duplicate key|immutable|cannot be enabled|not in this/i.test(msg)) {
    return NextResponse.json({ error: msg, code: 'CONFLICT' }, { status: 409 });
  }
  console.error('[dealer]', e);
  return NextResponse.json({ error: msg, code: 'INTERNAL_ERROR' }, { status: 500 });
}
