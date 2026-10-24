/**
 * Shared bits for the /api/close/flux/* routes (route files may only export handlers).
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isWriteScopeError } from '@/lib/db/scoped-writer';
import { EngineInputError, EngineScopeError } from '@/lib/reports/engine/adapter';
import { FluxNotFoundError } from './load';
import { isFluxError } from './service';

export const periodQuerySchema = z.object({
  location_id: z.string().uuid(),
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});

/** Map a flux / write-scope / not-found error to the standard JSON error body. */
export function fluxErrorResponse(e: unknown, label: string): NextResponse {
  if (isFluxError(e)) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
  if (isWriteScopeError(e)) return NextResponse.json({ error: e.message, code: 'FORBIDDEN' }, { status: 403 });
  // report_balances runs on the service role only for scope-checked companies (adapter).
  if (e instanceof EngineScopeError) return NextResponse.json({ error: e.message, code: 'FORBIDDEN_SCOPE' }, { status: 403 });
  if (e instanceof EngineInputError) return NextResponse.json({ error: e.message, code: 'INVALID_SCOPE' }, { status: 422 });
  if (e instanceof FluxNotFoundError) return NextResponse.json({ error: e.message, code: 'NOT_FOUND' }, { status: 404 });
  console.error(`[${label}]`, e instanceof Error ? e.message : e);
  return NextResponse.json({ error: 'Something went wrong loading the flux review.', code: 'INTERNAL_ERROR' }, { status: 500 });
}

export function noOrg(): NextResponse {
  return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
}
