export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { scopeQuery } from '@/lib/validations/cash-forecast';
import { cashError, cashRouteCtx, governCash } from '@/lib/cash/forecast/route-support';
import { computeRunwayFor, computeWorkspaceForecast } from '@/lib/cash/forecast/service';
import { loadCashLinesDetailed } from '@/lib/cash/forecast/load';
import { addMonths, startOfMonth } from '@/lib/cash/forecast/dates';
import { createMetricSource } from '@/lib/metrics/server-source';
import { evaluateFromSource } from '@/lib/metrics';
import type { MetricResult } from '@/lib/metrics';

/**
 * GET /api/cash/metrics?location_id
 *
 * Runway & liquidity (B5 / B6 / B7): runway in months at trailing burn (last 3 complete months of
 * book cash) and at forecast burn (base 13-week net ÷ 3), zero-cash date, liquidity = cash +
 * available lines, and the cash conversion cycle trend (registry metrics DSO + DIO − DPO, 12
 * month-ends, governed by the metric source). Permission cash.position:view.
 */
function series(r: MetricResult | undefined) {
  if (!r) return null;
  return {
    key: r.key,
    name: r.name,
    current: r.current.status === 'ok' ? r.current.value : null,
    reason: r.current.status === 'ok' ? null : r.current.message,
    points: r.sparkline.map((p) => ({ month: p.month, value: p.value, preliminary: p.preliminary })),
  };
}

export const GET = apiQueryHandler(scopeQuery, async (q, ctx) => {
  const c = await cashRouteCtx(ctx, q.location_id, 'position');
  if (c instanceof NextResponse) return c;
  try {
    const ids = c.companies.map((x) => x.id);
    const gov = await governCash(c, addMonths(startOfMonth(c.today), -4));
    const cash = await loadCashLinesDetailed(c.supabase, c.orgId, ids, c.today);
    const ws = await computeWorkspaceForecast(c.supabase, { orgId: c.orgId, companies: c.companies, today: c.today, scenarioId: null, openingBasis: gov.openingBasis, withAccuracy: false, cash });
    const runway = await computeRunwayFor(
      c.supabase,
      {
        orgId: c.orgId,
        companyIds: ids,
        today: c.today,
        forecastNetCents: ws.forecast.combined.totals.netCents,
        availableLinesCents: ws.liquidity.totalAvailableCents,
        zeroCashDate: ws.forecast.combined.zeroCashDate,
        cashNowCents: ws.forecast.combined.openingCents,
        shown: gov.shownDate,
      },
      cash,
    );

    let ccc: Record<string, ReturnType<typeof series>> | null = null;
    let cccError: string | null = null;
    try {
      const source = createMetricSource({ supabase: c.supabase, orgId: c.orgId, userId: c.userId }, { today: c.today });
      const periodEnd = addMonths(startOfMonth(c.today), -1).slice(0, 7);
      const keys = ['cash_conversion_cycle', 'dso', 'dio', 'dpo'];
      const { results } = await evaluateFromSource(
        source,
        keys.map((metric) => ({ metric, scope: { companyIds: ids, weighting: 'full' as const }, periodEnd, basis: 'month' as const, comparison: 'prior_period' as const, sparkline: 12 as const })),
      );
      ccc = Object.fromEntries(keys.map((k, i) => [k, series(results[i])]));
    } catch (e) {
      cccError = e instanceof Error ? e.message : 'Cash conversion cycle unavailable';
    }

    return NextResponse.json({
      today: c.today,
      runway,
      liquidity: ws.liquidity,
      openingBasis: gov.openingBasis,
      forecast: { netCents: ws.forecast.combined.totals.netCents, lowPoint: ws.forecast.combined.lowPoint, closingCents: ws.forecast.combined.closingCents },
      ccc,
      cccError,
      governance: gov.info ? { audience: gov.finance ? 'finance' : 'other', banner: gov.info.banner, footnote: gov.info.footnote } : null,
    });
  } catch (e) {
    return cashError(e, 'metrics');
  }
});
