export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { budgetCtx, budgetError, locationOfVersion } from '@/lib/budgets/route-support';
import { applyDriver } from '@/lib/budgets/service/lines';
import { driverSchema } from '@/lib/validations/budgets';

/**
 * POST /api/budgets/lines/driver — expand a driver (fixed monthly, annual even / seasonal, last year
 * + x%, % of revenue, headcount × rate, units × rate, last year's budget + x%) into a row's 12 months
 * and remember it. `dry_run: true` previews without writing.
 */
export const POST = apiHandler(driverSchema, async (i, ctx) => {
  const loc = await locationOfVersion(ctx.supabase, i.version_id);
  if (loc instanceof NextResponse) return loc;
  const b = await budgetCtx(ctx, loc);
  if (b instanceof NextResponse) return b;
  try {
    const r = await applyDriver(b, {
      versionId: i.version_id,
      departmentId: i.department_id,
      accountId: i.account_id,
      method: i.method,
      params: i.params ?? {},
      bridgeDriver: i.bridge_driver,
      note: i.note ?? null,
      dryRun: i.dry_run,
    });
    return NextResponse.json(r);
  } catch (e) {
    return budgetError(e, 'lines/driver');
  }
});
