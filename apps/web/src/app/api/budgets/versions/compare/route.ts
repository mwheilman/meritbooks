export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { budgetCtx, budgetError, locationOfVersion } from '@/lib/budgets/route-support';
import { compareVersions } from '@/lib/budgets/service/versions';
import { compareQuery } from '@/lib/validations/budgets';

/** GET /api/budgets/versions/compare?a&b — annual totals of two versions by account × department, largest change first. */
export const GET = apiQueryHandler(compareQuery, async (q, ctx) => {
  const loc = await locationOfVersion(ctx.supabase, q.a);
  if (loc instanceof NextResponse) return loc;
  const b = await budgetCtx(ctx, loc);
  if (b instanceof NextResponse) return b;
  try {
    return NextResponse.json(await compareVersions(b, q.a, q.b));
  } catch (e) {
    return budgetError(e, 'versions/compare');
  }
});
