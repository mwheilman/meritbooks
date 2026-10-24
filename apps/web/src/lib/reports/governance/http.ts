/**
 * Route helpers for /api/report-governance/* (kept out of route files — Next.js allows only
 * handler exports there). Server-only.
 */

import { NextResponse } from 'next/server';
import { isWriteScopeError } from '@/lib/db/scoped-writer';
import { GovernanceDeniedError } from './filter';
import { ReleaseError } from './releases';

export function governanceError(e: unknown): NextResponse {
  if (e instanceof ReleaseError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
  if (e instanceof GovernanceDeniedError) return NextResponse.json({ error: e.message, code: e.code, periods: e.periodKeys }, { status: 403 });
  if (isWriteScopeError(e)) return NextResponse.json({ error: (e as Error).message, code: 'FORBIDDEN' }, { status: 403 });
  const msg = e instanceof Error ? e.message : 'Something went wrong';
  // The DB's release-order trigger (mig 186), surfaced through any other write path.
  if (/RELEASE_ORDER/.test(msg)) {
    return NextResponse.json({ error: 'Months are released in order — release the previous month first, or take back the next month first.', code: 'RELEASE_ORDER' }, { status: 409 });
  }
  if (/at least 4/.test(msg)) return NextResponse.json({ error: msg, code: 'REASON_REQUIRED' }, { status: 422 });
  if (/not found/i.test(msg)) return NextResponse.json({ error: msg, code: 'NOT_FOUND' }, { status: 404 });
  return NextResponse.json({ error: msg, code: 'INTERNAL_ERROR' }, { status: 500 });
}

export function noOrg(): NextResponse {
  return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
}

export const PERIOD_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
