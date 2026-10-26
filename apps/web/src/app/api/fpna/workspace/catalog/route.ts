export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { GROUP_LABEL, GROUP_ORDER, metricCatalog } from '@/lib/fpna/workspace/catalog';
import { packList } from '@/lib/fpna/workspace/dashboard-model';
import { noOrg } from '@/lib/fpna/workspace/server/route-support';

/**
 * GET /api/fpna/workspace/catalog — the KPI card catalog (every registry metric with its
 * generated formula, definition, unit, direction and requirements) and the built-in packs.
 * No figures. reports:view.
 */
export const GET = apiQueryHandler(null, async (_q, ctx) => {
  if (!ctx.orgId) return noOrg();
  const guard = await requirePermission(ctx.userId, 'reports', 'view', { route: '/api/fpna/workspace/catalog' });
  if (!guard.ok) return guard.response;
  return NextResponse.json({
    metrics: metricCatalog(),
    groups: GROUP_ORDER.map((g) => ({ key: g, label: GROUP_LABEL[g] })),
    packs: packList(),
  });
});
