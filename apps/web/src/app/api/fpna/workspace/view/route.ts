export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { viewQueryRouteSchema } from '@/lib/fpna/workspace/query';
import { prepare } from '@/lib/fpna/workspace/server/load';
import { buildView } from '@/lib/fpna/workspace/server/views';
import { noOrg, serverCtx, workspaceErrorResponse } from '@/lib/fpna/workspace/server/route-support';

/**
 * GET /api/fpna/workspace/view — one /fpna tab (FPB-reports-fpna §4.13).
 *
 * reports:view. RLS-scoped (runs as the user); client scope is enforced by the engine feed
 * (403 CLIENT_SCOPE_DENIED for an out-of-scope company). NUMBER GOVERNANCE: the metric
 * dataset is governed for the reader before any figure is computed (non-finance: released
 * months only, cumulative rule for balances); engine statements govern themselves; dimension
 * balances and covenants run through route-guard. One dataset load per view; cached per
 * (org, user, scope, period, basis, comparison, ledger epoch) for 60 s.
 */
export const GET = apiQueryHandler(viewQueryRouteSchema, async (q, ctx) => {
  if (!ctx.orgId) return noOrg();
  const guard = await requirePermission(ctx.userId, 'reports', 'view', { route: '/api/fpna/workspace/view' });
  if (!guard.ok) return guard.response;
  try {
    const p = await prepare(serverCtx({ ...ctx, orgId: ctx.orgId }));
    const view = await buildView(p, q, { role: guard.role });
    return NextResponse.json(view);
  } catch (e) {
    return workspaceErrorResponse(e, 'fpna/workspace/view');
  }
});
