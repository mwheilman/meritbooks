export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiQueryHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { loadFluxBoard } from '@/lib/close/flux/load';
import { buildFluxPackageSection, fluxCsv } from '@/lib/close/flux/package';
import { fluxErrorResponse, noOrg, periodQuerySchema } from '@/lib/close/flux/route-support';

/**
 * GET /api/close/flux/export?location_id&year&month&format=csv|json
 *   csv  — the full flux list with explanations (download).
 *   json — the close-package / board-pack section (`buildFluxPackageSection`).
 */
const schema = periodQuerySchema.extend({ format: z.enum(['csv', 'json']).optional() });

export const GET = apiQueryHandler(schema, async (q, ctx) => {
  if (!ctx.orgId) return noOrg();
  const guard = await requirePermission(ctx.userId, 'close_mgmt', 'view', { locationId: q.location_id });
  if (!guard.ok) return guard.response;
  try {
    const board = await loadFluxBoard(ctx.supabase, ctx.orgId, { locationId: q.location_id, year: q.year, month: q.month });
    if (q.format === 'json') return NextResponse.json(buildFluxPackageSection(board));
    const safeName = board.location.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'company';
    return new NextResponse(fluxCsv(board), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="flux-${safeName}-${board.period.key}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return fluxErrorResponse(e, 'close/flux/export');
  }
});
