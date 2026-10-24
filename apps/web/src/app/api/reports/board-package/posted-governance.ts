/**
 * Governance for the board-package RENDER routes (pdf / xlsx). Those routes format a package
 * the client POSTs (the one it is previewing), so they cannot prove the figures came from a
 * governed GET. Two guards:
 *
 *   1. A non-finance caller may only render a package whose period is released: the window,
 *      the as-of balance and today's aging month, cumulative, for EVERY company in the org
 *      (the posted package does not say which companies it covers — the strictest scope).
 *      Otherwise 403 NOT_RELEASED.
 *   2. Every rendered document is stamped as prepared from the on-screen package (never
 *      presented as a released, server-governed statement).
 */

import { NextResponse } from 'next/server';
import type { ApiContext } from '@/lib/api-handler';
import type { BoardPackage } from '@/lib/reports/board-package';
import { getOrgToday } from '@/lib/dates/org-today';
import { asOfMonth, governRoute, rangeMonths, rangeTooLongResponse, resolveRouteAudience, type RouteGuardDeps } from '@/lib/reports/governance/route-guard';

export { UNGOVERNED_FOOTNOTE } from '@/lib/reports/export/statement-model';

export async function governPostedPackage(
  ctx: ApiContext,
  pkg: Pick<BoardPackage, 'meta'>,
  deps?: RouteGuardDeps,
): Promise<NextResponse | null> {
  const audience = await resolveRouteAudience({ userId: ctx.userId, deps });
  if (audience.audience === 'finance') return null;
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  const months = rangeMonths(pkg.meta.periodStart, pkg.meta.periodEnd);
  if (!months) return rangeTooLongResponse();
  const today = await getOrgToday(ctx.supabase, ctx.orgId);
  const g = await governRoute(
    { supabase: ctx.supabase, orgId: ctx.orgId, userId: ctx.userId, audience, deps },
    { months: [...months, asOfMonth(pkg.meta.asOfDate), asOfMonth(today)], locationIds: [], cumulative: true },
  );
  return g instanceof NextResponse ? g : null;
}
