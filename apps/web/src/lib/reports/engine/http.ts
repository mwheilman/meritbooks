/**
 * Shared HTTP helpers for the engine routes (server only).
 */
import { NextResponse } from 'next/server';
import type { ZodError } from 'zod';
import { EngineInputError, EngineScopeError } from './adapter';
import { MissingBalancesError } from './aggregate';
import { GovernanceDeniedError } from '@/lib/reports/governance/filter';

export function engineErrorResponse(e: unknown): NextResponse {
  if (e instanceof EngineScopeError) {
    return NextResponse.json({ error: e.message, code: 'CLIENT_SCOPE_DENIED', companyIds: e.companyIds }, { status: 403 });
  }
  if (e instanceof GovernanceDeniedError) {
    return NextResponse.json({ error: e.message, code: e.code, periods: e.periodKeys }, { status: 403 });
  }
  if (e instanceof EngineInputError) {
    return NextResponse.json({ error: e.message, code: 'INVALID_REPORT' }, { status: 422 });
  }
  if (e instanceof MissingBalancesError) {
    return NextResponse.json({ error: 'The report could not load all the periods it needs. Try again.', code: 'ENGINE_RANGE' }, { status: 500 });
  }
  const msg = e instanceof Error ? e.message : 'Report failed';
  return NextResponse.json({ error: msg, code: 'ENGINE_ERROR' }, { status: 500 });
}

export function validationResponse(error: ZodError): NextResponse {
  return NextResponse.json({ error: 'Invalid report request', code: 'VALIDATION_ERROR', details: error.flatten() }, { status: 422 });
}

/**
 * Finance-only writes (report layouts): the caller must hold close_mgmt:manage OR
 * journal_entries:create — the same capability test as the governance audience
 * (lib/reports/governance/audience.ts). Returns a 403 response, or null when allowed.
 */
export async function requireFinanceWriter(userId: string): Promise<NextResponse | null> {
  const { permissionProbe, resolveGovernanceAudience } = await import('@/lib/reports/governance/audience');
  const aud = await resolveGovernanceAudience(permissionProbe(userId));
  if (aud.audience === 'finance') return null;
  return NextResponse.json(
    { error: 'Only finance (close management or journal entry rights) can change report layouts.', code: 'FORBIDDEN' },
    { status: 403 },
  );
}
