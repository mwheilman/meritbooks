export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { budgetCtx, budgetError, locationOfVersion } from '@/lib/budgets/route-support';
import { getBoard } from '@/lib/budgets/service/plans';
import { boardQuery } from '@/lib/validations/budgets';

/** GET /api/budgets/board?version_id — the submission board: every department the caller may see, with owner, status, due, plan vs last year. */
export const GET = apiQueryHandler(boardQuery, async (q, ctx) => {
  const loc = await locationOfVersion(ctx.supabase, q.version_id);
  if (loc instanceof NextResponse) return loc;
  const b = await budgetCtx(ctx, loc);
  if (b instanceof NextResponse) return b;
  try {
    return NextResponse.json(await getBoard(b, q.version_id));
  } catch (e) {
    return budgetError(e, 'board');
  }
});
