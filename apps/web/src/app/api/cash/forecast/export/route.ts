export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { exportQuery } from '@/lib/validations/cash-forecast';
import { cashError, cashRouteCtx, governCash, scenarioParam } from '@/lib/cash/forecast/route-support';
import { computeWorkspaceForecast } from '@/lib/cash/forecast/service';
import { addDays } from '@/lib/cash/forecast/dates';
import { forecastCsv } from '@/lib/cash/forecast/export';

/**
 * GET /api/cash/forecast/export?location_id&scenario_id&view=weeks|items → CSV download.
 * weeks = week × category grid (opening, every category, net, closing, band, minimum);
 * items = every forecast item with its date, category, certainty, probability and source.
 */
export const GET = apiQueryHandler(exportQuery, async (q, ctx) => {
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
      withAccuracy: false,
    });
    const scopeName = c.locationId ? (c.companies[0]?.name ?? 'Company') : 'All companies';
    const csv = forecastCsv(ws, q.view ?? 'weeks', scopeName);
    const name = `cash-forecast-${q.view ?? 'weeks'}-${scopeName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${c.today}.csv`;
    return new NextResponse(csv, { status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` } });
  } catch (e) {
    return cashError(e, 'forecast export');
  }
});
