export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { scopeQuery } from '@/lib/validations/cash-forecast';
import { cashError, cashRouteCtx, governCash, scenarioParam } from '@/lib/cash/forecast/route-support';
import { computeWorkspaceForecast } from '@/lib/cash/forecast/service';
import { addDays } from '@/lib/cash/forecast/dates';

/**
 * GET /api/cash/forecast?location_id=<uuid|all>&scenario_id=<uuid|base>
 *
 * The direct 13-week cash forecast (FPB-reports-fpna §4.12): opening book cash, every dated source
 * (AR at predicted pay dates, recurring billing, AP, payroll, debt, leases, subscriptions, taxes,
 * budget run-rate, manual items), the scenario's levers, weekly + daily series per company and
 * combined with an 80% band, minimum-cash breaches, recommendations and liquidity headroom.
 * Permission cash.forecast:view; client-scoped; RLS reads; governed opening balance.
 */
export const GET = apiQueryHandler(scopeQuery, async (q, ctx) => {
  const c = await cashRouteCtx(ctx, q.location_id, 'view');
  if (c instanceof NextResponse) return c;
  try {
    const gov = await governCash(c, addDays(c.today, -7 * 10));
    const ws = await computeWorkspaceForecast(c.supabase, {
      orgId: c.orgId,
      companies: c.companies,
      today: c.today,
      scenarioId: scenarioParam(q.scenario_id),
      openingBasis: gov.openingBasis,
      shownWeek: gov.shownWeek,
    });
    return NextResponse.json({
      ...ws,
      scope: { locationId: c.locationId, companyIds: c.companies.map((x) => x.id), companies: c.allCompanies.map((x) => ({ id: x.id, name: x.name })) },
      governance: gov.info ? { audience: gov.finance ? 'finance' : 'other', banner: gov.info.banner, footnote: gov.info.footnote } : null,
    });
  } catch (e) {
    return cashError(e, 'forecast');
  }
});
