export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { historyQuery } from '@/lib/validations/cash-forecast';
import { cashError, cashRouteCtx, governCash } from '@/lib/cash/forecast/route-support';
import { computeHistory } from '@/lib/cash/forecast/service';
import { historyDates } from '@/lib/cash/forecast/history';

/**
 * GET /api/cash/trend?location_id&weeks=13 — legacy alias of /api/cash/history (weekly).
 *
 * FIXED (Wave 4C, AC-CF10): the trend used to be back-calculated from today's bank-feed balance
 * through the feed. It is now the posted BOOK cash at each week-end from the GL cash accounts (by
 * role / flag), with the bank-feed balance beside it and the difference per point. `closingCents`
 * stays the book figure so older readers keep working. Governed (non-finance → released months).
 */
export const GET = apiQueryHandler(historyQuery.extend({ weeks: historyQuery.shape.points }), async (q, ctx) => {
  const c = await cashRouteCtx(ctx, q.location_id, 'position');
  if (c instanceof NextResponse) return c;
  const points = Math.min(27, Math.max(5, (q.weeks ?? 13) + 1));
  try {
    const dates = historyDates(c.today, 'week', points);
    const gov = await governCash(c, dates[0]);
    const h = await computeHistory(c.supabase, { orgId: c.orgId, companyIds: c.companies.map((x) => x.id), today: c.today, grain: 'week', points, shown: gov.shownDate });
    return NextResponse.json({
      points: h.points.map((p) => ({ date: p.date, closingCents: p.bookCents, bankCents: p.bankCents, diffCents: p.diffCents })),
      startCents: h.summary.startCents,
      endCents: h.summary.endCents,
      changeCents: h.summary.changeCents,
      changePct: h.summary.startCents ? ((h.summary.changeCents ?? 0) / Math.abs(h.summary.startCents)) * 100 : null,
      minCents: h.summary.minCents,
      maxCents: h.summary.maxCents,
      basis: 'BOOK',
      accountCount: h.bankAccountCount,
      transactionCount: h.bankTxnCount,
      hasFeed: h.bankTxnCount > 0,
      meta: { locationId: c.locationId, consolidated: !c.locationId },
    });
  } catch (e) {
    return cashError(e, 'trend');
  }
});
