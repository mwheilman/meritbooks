export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { loadFluxBoard } from '@/lib/close/flux/load';
import { fluxErrorResponse, noOrg, periodQuerySchema } from '@/lib/close/flux/route-support';

/**
 * GET /api/close/flux?location_id&year&month — the Flux review board for one company and
 * month (FPB-financial-reports §5): every in-scope line with current / comparison / change,
 * the threshold applied, trailing series, drivers, explanation + review state, carry-forward
 * suggestion, and the close-gate status. READ-ONLY, RLS-scoped.
 */
export const GET = apiQueryHandler(periodQuerySchema, async (q, ctx) => {
  if (!ctx.orgId) return noOrg();
  const guard = await requirePermission(ctx.userId, 'close_mgmt', 'view', { locationId: q.location_id });
  if (!guard.ok) return guard.response;
  try {
    const board = await loadFluxBoard(ctx.supabase, ctx.orgId, { locationId: q.location_id, year: q.year, month: q.month });
    return NextResponse.json(board);
  } catch (e) {
    return fluxErrorResponse(e, 'close/flux');
  }
});
