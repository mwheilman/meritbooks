export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { budgetCtx, budgetError, locationOfVersion } from '@/lib/budgets/route-support';
import { getGrid, saveCells } from '@/lib/budgets/service/lines';
import { deptOf, gridQuery, saveCellsSchema } from '@/lib/validations/budgets';

/**
 * GET /api/budgets/lines?version_id&department_id — the grid for one department ('' / 'company' =
 *     company-level lines): rows with 12 months, last year's actuals, drivers, lock reason.
 * PUT — save cell edits (typed or pasted). Refused (409) when the version isn't a draft or the
 *     department is submitted / approved; 403 outside the caller's departments.
 */
export const GET = apiQueryHandler(gridQuery, async (q, ctx) => {
  const loc = await locationOfVersion(ctx.supabase, q.version_id);
  if (loc instanceof NextResponse) return loc;
  const b = await budgetCtx(ctx, loc);
  if (b instanceof NextResponse) return b;
  try {
    return NextResponse.json(await getGrid(b, q.version_id, deptOf(q.department_id)));
  } catch (e) {
    return budgetError(e, 'lines GET');
  }
});

export const PUT = apiHandler(saveCellsSchema, async (i, ctx) => {
  const loc = await locationOfVersion(ctx.supabase, i.version_id);
  if (loc instanceof NextResponse) return loc;
  const b = await budgetCtx(ctx, loc);
  if (b instanceof NextResponse) return b;
  try {
    const r = await saveCells(
      b,
      i.version_id,
      i.department_id,
      i.edits.map((e) => ({ accountId: e.account_id, periodNumber: e.period_number, amountCents: e.amount_cents })),
      i.source ?? 'MANUAL',
    );
    return NextResponse.json(r);
  } catch (e) {
    return budgetError(e, 'lines PUT');
  }
});
