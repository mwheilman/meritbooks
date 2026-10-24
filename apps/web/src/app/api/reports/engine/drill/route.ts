export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { runDrill } from '@/lib/reports/engine/adapter';
import { drillRequestSchema } from '@/lib/reports/engine/schema';
import { engineErrorResponse, validationResponse } from '@/lib/reports/engine/http';
import type { DrillRequest } from '@/lib/reports/engine/types';

/**
 * POST /api/reports/engine/drill — the GL lines behind one statement cell, read from the
 * LEDGER (not the balances store) so the drill independently proves the figure. Totals
 * cover the whole filtered set; lines are paginated (≤ 1,000 per page) with a running
 * balance, each linking to its journal entry and source document. reports:view; every month
 * of the range must be released for the caller (403 NOT_RELEASED) and the in-group windows
 * are computed server-side (lib/reports/governance — client windows can only narrow).
 */
export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  const guard = await requirePermission(userId, 'reports', 'view', { route: '/api/reports/engine/drill' });
  if (!guard.ok) return guard.response;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = drillRequestSchema.safeParse(raw);
  if (!parsed.success) return validationResponse(parsed.error);
  try {
    const data = await runDrill({ supabase, orgId, userId }, parsed.data as DrillRequest);
    return NextResponse.json({ data });
  } catch (e) {
    return engineErrorResponse(e);
  }
}
