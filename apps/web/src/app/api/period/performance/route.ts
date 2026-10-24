export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiQueryHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { keepMonths, loadBudgetPnlByMonth, loadPnlByMonth, netIncomeOf, sumPnl } from '@/lib/fpna/pnl-range';
import { governRouteMonths } from '@/lib/reports/governance/route-guard';
import { marginPct, type PnlAggregate } from '@/lib/fpna/dashboard';
import { minMonth, monthRange, normalizeFyStart, resolveComparison, windowBounds, type PeriodBasis } from '@/lib/period/resolve';

/**
 * GET /api/period/performance — profit and loss for ANY picked window (the shared PeriodPicker on
 * the home dashboard): revenue → gross profit → operating income → net income for the window,
 * the same figures for the comparison window (prior period · prior year · budget), and net income
 * by month across the window.
 *
 *   ?period_end=YYYY-MM&basis=month|qtd|quarter|ytd|fy|ttm|range[&period_start=YYYY-MM]
 *    &compare=none|prior_period|prior_year|budget[&location_id=…]
 *
 * Read-only, RLS-scoped (runs as the user), gated on reports:view (the same permission as the
 * statements it summarizes). Same account-type math as the income statement (lib/fpna/pnl-range).
 *
 * Number governance (route-guard): for a non-finance caller, months not released for every
 * company in scope are DROPPED — `current` sums released months only, `byMonth` omits the
 * withheld months, an actual comparison with any withheld month is withheld (figures null).
 * `governance.withheldPeriods` lists what was dropped; finance passes through (preview).
 */

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const query = z.object({
  period_end: z.string().regex(MONTH),
  period_start: z.string().regex(MONTH).optional(),
  basis: z.enum(['month', 'qtd', 'quarter', 'ytd', 'fy', 'ttm', 'range']).optional(),
  compare: z.enum(['none', 'prior_period', 'prior_year', 'budget']).optional(),
  location_id: z.string().optional(),
});

interface PerformanceFigures {
  revenueCents: number;
  cogsCents: number;
  grossProfitCents: number;
  opexCents: number;
  operatingIncomeCents: number;
  otherCents: number;
  netIncomeCents: number;
  grossMarginPct: number | null;
  netMarginPct: number | null;
}

function figures(p: PnlAggregate): PerformanceFigures {
  const grossProfitCents = p.revenueCents - p.cogsCents;
  const operatingIncomeCents = grossProfitCents - p.opexCents;
  const netIncomeCents = netIncomeOf(p);
  return {
    revenueCents: p.revenueCents,
    cogsCents: p.cogsCents,
    grossProfitCents,
    opexCents: p.opexCents,
    operatingIncomeCents,
    otherCents: p.otherCents,
    netIncomeCents,
    grossMarginPct: marginPct(grossProfitCents, p.revenueCents),
    netMarginPct: marginPct(netIncomeCents, p.revenueCents),
  };
}

export const GET = apiQueryHandler(query, async (q, ctx) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  const guard = await requirePermission(ctx.userId, 'reports', 'view', { route: '/api/period/performance' });
  if (!guard.ok) return guard.response;
  const { supabase, orgId } = ctx;

  const locationIds = q.location_id && q.location_id !== 'all' && UUID_RE.test(q.location_id) ? [q.location_id] : [];
  const { data: orgRow } = await supabase.schema('core').from('organizations').select('fiscal_year_start_month').eq('id', orgId).maybeSingle();
  const fyStart = normalizeFyStart((orgRow as { fiscal_year_start_month?: number | null } | null)?.fiscal_year_start_month ?? 1);

  const basis: PeriodBasis = q.basis ?? (q.period_start ? 'range' : 'month');
  const b = windowBounds({ basis, end: q.period_end, start: q.period_start }, fyStart);
  const months = monthRange(b.start, b.end);
  if (months.length > 60) return NextResponse.json({ error: 'Pick a window of five years or less', code: 'RANGE_TOO_LONG' }, { status: 422 });
  const cmp = resolveComparison(basis, { start: b.start, end: b.end, months }, q.compare ?? 'none', fyStart);
  const scope = { orgId, locationIds, departmentId: null };

  const from = cmp && cmp.kind !== 'budget' ? minMonth(cmp.start, b.start) : b.start;
  const actualMonths = cmp && cmp.kind !== 'budget' ? Array.from(new Set([...months, ...cmp.months])) : months;
  const gov = await governRouteMonths({ supabase, orgId, userId: ctx.userId }, { months: actualMonths, locationIds });
  const loaded = await loadPnlByMonth(supabase, scope, from, b.end);
  if (loaded.error) return NextResponse.json({ error: loaded.error, code: 'QUERY_ERROR' }, { status: 500 });
  // Withheld months never leave the server — dropped before any figure is computed.
  const actuals = { data: keepMonths(loaded.data, (m) => gov.isShown(m)) };
  const shownMonths = months.filter((m) => gov.isShown(m));

  let comparison: { kind: string; label: string; vsLabel: string; start: string; end: string; figures: PerformanceFigures | null } | null = null;
  if (cmp) {
    let pnl: PnlAggregate | null;
    if (cmp.kind === 'budget') {
      const budget = await loadBudgetPnlByMonth(supabase, scope, b.start, b.end, fyStart);
      if (budget.error) return NextResponse.json({ error: budget.error, code: 'QUERY_ERROR' }, { status: 500 });
      pnl = budget.hasBudget ? sumPnl(budget.data, months) : null;
    } else {
      // A comparison is one figure: any withheld month withholds it (never a partial sum).
      pnl = cmp.months.every((m) => gov.isShown(m)) ? sumPnl(actuals.data, cmp.months) : null;
    }
    comparison = { kind: cmp.kind, label: cmp.label, vsLabel: cmp.vsLabel, start: cmp.start, end: cmp.end, figures: pnl ? figures(pnl) : null };
  }

  const current = sumPnl(actuals.data, shownMonths);
  const anyActivity = shownMonths.some((m) => Boolean(actuals.data[m]));
  return NextResponse.json({
    data: {
      window: { start: b.start, end: b.end, months: months.length, basis },
      current: figures(current),
      hasActivity: anyActivity,
      comparison,
      byMonth: shownMonths.map((m) => ({ month: m, netIncomeCents: actuals.data[m] ? netIncomeOf(actuals.data[m]) : 0, revenueCents: actuals.data[m]?.revenueCents ?? 0 })),
      withheldMonths: months.filter((m) => !gov.isShown(m)),
    },
    governance: gov.info,
  });
});
