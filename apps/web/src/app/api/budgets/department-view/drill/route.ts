export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { budgetCtx, budgetError } from '@/lib/budgets/route-support';
import { getDrill } from '@/lib/budgets/service/department-view';
import { deptOf, drillQuery } from '@/lib/validations/budgets';

/** GET /api/budgets/department-view/drill — the POSTED GL lines behind one department × account × window (actual or prior year). */
export const GET = apiQueryHandler(drillQuery, async (q, ctx) => {
  const b = await budgetCtx(ctx, q.location_id);
  if (b instanceof NextResponse) return b;
  try {
    return NextResponse.json(
      await getDrill(b, {
        locationId: q.location_id,
        fiscalYear: q.fiscal_year,
        month: q.month,
        window: q.window ?? 'YTD',
        departmentId: deptOf(q.department_id),
        accountId: q.account_id,
        which: q.which ?? 'actual',
      }),
    );
  } catch (e) {
    return budgetError(e, 'department-view/drill');
  }
});
