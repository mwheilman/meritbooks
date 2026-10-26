export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { historyQuery } from '@/lib/validations/cash-forecast';
import { cashError, cashRouteCtx, governCash } from '@/lib/cash/forecast/route-support';
import { computeHistory } from '@/lib/cash/forecast/service';
import { historyDates } from '@/lib/cash/forecast/history';

/**
 * GET /api/cash/history?location_id&grain=day|week|month&points=N
 *
 * Historical cash (AC-CF10): the posted BOOK cash balance at each date from the GL cash accounts
 * (by role / flag), the bank-feed balance at the same dates (rewound from the current feed balance),
 * and the per-point difference. Governed: a non-finance reader sees book balances only for released
 * months (cumulative); withheld points are gaps, never zero. Permission cash.position:view.
 */
export const GET = apiQueryHandler(historyQuery, async (q, ctx) => {
  const c = await cashRouteCtx(ctx, q.location_id, 'position');
  if (c instanceof NextResponse) return c;
  const grain = q.grain ?? 'week';
  const points = q.points ?? (grain === 'day' ? 90 : grain === 'week' ? 26 : 13);
  try {
    const dates = historyDates(c.today, grain, points);
    const gov = await governCash(c, dates[0]);
    const h = await computeHistory(c.supabase, { orgId: c.orgId, companyIds: c.companies.map((x) => x.id), today: c.today, grain, points, shown: gov.shownDate });
    return NextResponse.json({
      ...h,
      today: c.today,
      withheld: h.points.filter((p) => p.bookCents === null).length,
      governance: gov.info ? { audience: gov.finance ? 'finance' : 'other', banner: gov.info.banner, footnote: gov.info.footnote } : null,
    });
  } catch (e) {
    return cashError(e, 'history');
  }
});
