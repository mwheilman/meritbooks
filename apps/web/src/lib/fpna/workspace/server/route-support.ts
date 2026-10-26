/** Shared HTTP helpers for /api/fpna/workspace/* (server only). */

import { NextResponse } from 'next/server';
import type { ApiContext } from '@/lib/api-handler';
import { EngineInputError, EngineScopeError } from '@/lib/reports/engine/adapter';
import { GovernanceDeniedError } from '@/lib/reports/governance/filter';
import { DashboardStoreError } from './dashboards-store';
import type { WsServerCtx } from './load';
import { WorkspaceInputError } from './views';

export function noOrg(): NextResponse {
  return NextResponse.json({ error: 'No organization in session', code: 'NO_ORG' }, { status: 400 });
}

export function serverCtx(ctx: ApiContext & { orgId: string }): WsServerCtx {
  return { supabase: ctx.supabase, orgId: ctx.orgId, userId: ctx.userId };
}

export function workspaceErrorResponse(e: unknown, route: string): NextResponse {
  if (e instanceof DashboardStoreError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
  if (e instanceof WorkspaceInputError || e instanceof EngineInputError) return NextResponse.json({ error: e.message, code: 'INVALID_VIEW' }, { status: 422 });
  if (e instanceof EngineScopeError) return NextResponse.json({ error: e.message, code: 'CLIENT_SCOPE_DENIED', companyIds: e.companyIds }, { status: 403 });
  if (e instanceof GovernanceDeniedError) return NextResponse.json({ error: e.message, code: e.code, periods: e.periodKeys }, { status: 403 });
  // Generic body: the detail can carry SQL / schema / provider text — it goes to the server log only.
  console.error(`[${route}]`, e instanceof Error ? e.message : e);
  return NextResponse.json({ error: 'The FP&A view could not be computed. Please try again.', code: 'FPNA_ERROR' }, { status: 500 });
}
