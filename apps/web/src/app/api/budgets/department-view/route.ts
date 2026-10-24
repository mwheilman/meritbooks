export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { budgetCtx, budgetError } from '@/lib/budgets/route-support';
import { getDepartmentView } from '@/lib/budgets/service/department-view';
import { deptOf, departmentViewQuery } from '@/lib/validations/budgets';

/**
 * GET /api/budgets/department-view?location_id&fiscal_year&month&window&department_id[&version_id]
 *     — department P&L actual vs budget vs prior year (MONTH / QTD / YTD / TTM), material variances
 *     with explanations, and the three bridges (last year → budget, budget → actual, budget → forecast).
 */
export const GET = apiQueryHandler(departmentViewQuery, async (q, ctx) => {
  const b = await budgetCtx(ctx, q.location_id);
  if (b instanceof NextResponse) return b;
  try {
    return NextResponse.json(
      await getDepartmentView(b, {
        locationId: q.location_id,
        fiscalYear: q.fiscal_year,
        month: q.month,
        window: q.window ?? 'YTD',
        departmentId: deptOf(q.department_id),
        versionId: q.version_id ?? null,
      }),
    );
  } catch (e) {
    return budgetError(e, 'department-view');
  }
});
