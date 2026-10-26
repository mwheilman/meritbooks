export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { accuracyQuery } from '@/lib/validations/cash-forecast';
import { cashError, cashRouteCtx, governCash } from '@/lib/cash/forecast/route-support';
import { accuracyReport } from '@/lib/cash/forecast/service';
import { loadCashLinesDetailed, loadSnapshots } from '@/lib/cash/forecast/load';
import { ACCURACY_GROUP_LABEL, sumSnapshots } from '@/lib/cash/forecast/accuracy';
import { addDays } from '@/lib/cash/forecast/dates';

/**
 * GET /api/cash/accuracy?location_id&lead=1..4&weeks=N
 *
 * Forecast vs actual by week (and by group) from the weekly snapshots (cash_forecast_snapshots,
 * migration 192) and posted GL cash, with MAPE and the rolling accuracy trend (AC-CF7). Weeks whose
 * GL activity isn't released to a non-finance reader are left out. Permission cash.forecast:view.
 *
 * Security review H4: the snapshot list for a multi-company scope uses the stored combined row only
 * for a caller with all-clients scope (RLS hides it from everyone else anyway); a scoped caller gets
 * the sum of their own companies' rows. A snapshot's opening / closing / weeks are book-derived, so
 * a non-finance reader sees them only when the anchor date's books are released (cumulative rule).
 */
export const GET = apiQueryHandler(accuracyQuery, async (q, ctx) => {
  const c = await cashRouteCtx(ctx, q.location_id, 'view');
  if (c instanceof NextResponse) return c;
  try {
    const ids = c.companies.map((x) => x.id);
    const weeks = q.weeks ?? 12;
    const lead = q.lead ?? 1;
    const gov = await governCash(c, addDays(c.today, -7 * (weeks + 1)));
    const cash = await loadCashLinesDetailed(c.supabase, c.orgId, ids, c.today);
    const scopeCompany = ids.length === 1 ? ids[0] : null;
    const report = await accuracyReport(c.supabase, c.orgId, cash, c.today, scopeCompany, ids, { weeks, lead, shownWeek: gov.shownWeek });
    const recent = await loadSnapshots(c.supabase, c.orgId, addDays(c.today, -7 * 26));
    type Snap = (typeof recent)[number];
    let mine: Snap[];
    if (scopeCompany || c.scopeBypass) {
      mine = recent.filter((s) => s.companyId === scopeCompany);
    } else {
      // Σ the caller's own companies' rows per week (never the org-wide combined row).
      const parts = recent.filter((s) => s.companyId !== null && ids.includes(s.companyId));
      const summed = sumSnapshots(
        parts.map((s) => ({ anchorDate: s.anchorDate, companyId: s.companyId, openingCents: s.openingCents, weeks: Array.isArray(s.weeks) ? (s.weeks as never[]) : [] })),
        ids,
      );
      mine = summed.map((r) => {
        const rows = parts.filter((p) => p.anchorDate === r.anchorDate);
        return {
          anchorDate: r.anchorDate,
          companyId: null,
          openingCents: r.openingCents,
          closingCents: rows.reduce((acc, p) => acc + p.closingCents, 0),
          weeks: r.weeks,
          createdAt: rows.reduce<string | null>((m, p) => (p.createdAt && (!m || p.createdAt > m) ? p.createdAt : m), null),
          source: rows.every((p) => p.source === 'SCHEDULED') ? 'SCHEDULED' : 'MANUAL',
        };
      });
    }
    // Governance: book-derived figures only for released anchor dates (finance sees all).
    const shown = (s: Snap) => gov.finance || gov.shownDate(s.anchorDate);
    const latest = mine.length ? mine[mine.length - 1] : null;
    return NextResponse.json({
      ...report,
      groups: ACCURACY_GROUP_LABEL,
      latestSnapshot: latest ? (shown(latest) ? latest : { ...latest, openingCents: null, closingCents: null, weeks: [] }) : null,
      snapshots: mine.map((s) => ({
        anchorDate: s.anchorDate,
        openingCents: shown(s) ? s.openingCents : null,
        closingCents: shown(s) ? s.closingCents : null,
        source: s.source,
        createdAt: s.createdAt,
      })),
      today: c.today,
      governance: gov.info ? { audience: gov.finance ? 'finance' : 'other', banner: gov.info.banner, footnote: gov.info.footnote } : null,
    });
  } catch (e) {
    return cashError(e, 'accuracy');
  }
});
