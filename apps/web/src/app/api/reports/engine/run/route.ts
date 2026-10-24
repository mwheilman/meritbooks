export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { runReport } from '@/lib/reports/engine/adapter';
import { runBodySchema } from '@/lib/reports/engine/schema';
import { engineErrorResponse, validationResponse } from '@/lib/reports/engine/http';
import { recordRun } from '@/lib/reports/engine/prefs';
import type { ReportRequest } from '@/lib/reports/engine/types';

/**
 * POST /api/reports/engine/run — run any engine statement (FPB-financial-reports §4 A-3A).
 * Body: ReportRequest (+ optional reportKey for "recently run"). Runs AS THE CALLER (RLS:
 * org + client scope); requested companies are validated against the caller's client
 * scope (403 CLIENT_SCOPE_DENIED). Gated on reports:view. Read-only.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  const guard = await requirePermission(userId, 'reports', 'view', { route: '/api/reports/engine/run' });
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = runBodySchema.safeParse(raw);
  if (!parsed.success) return validationResponse(parsed.error);
  const { reportKey, ...body } = parsed.data;
  try {
    const result = await runReport({ supabase, orgId, userId }, body as ReportRequest);
    if (reportKey) await recordRun(orgId, userId, reportKey, body);
    return NextResponse.json({ data: result });
  } catch (e) {
    return engineErrorResponse(e);
  }
}
