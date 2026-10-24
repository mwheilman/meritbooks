export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiQueryHandler } from '@/lib/api-handler';
import { getOrgToday } from '@/lib/dates/org-today';
import { fetchAll } from '@/lib/supabase/fetch-all';
import { summarizeClose, type PeriodStatusRow } from '@/lib/period/closed';
import { currentMonthOf, normalizeFyStart } from '@/lib/period/resolve';

/**
 * GET /api/period/context — what every period picker needs to be fiscal-year and close aware,
 * in one small read:
 *
 *   { fyStartMonth, today, currentMonth, closedThrough, months: { 'YYYY-MM': closed|soft|open } }
 *
 * - fyStartMonth: core.organizations.fiscal_year_start_month (the same value the report engine
 *   meta and the metrics adapter use, so the picker's quarters match the reports').
 * - today/currentMonth: the ORG's calendar date (core.organizations.timezone), never UTC.
 * - closedThrough / months: fiscal_periods (004) over the last 4 fiscal years for the companies
 *   in scope (`location_id` / `location_ids`, else every company RLS returns). HARD_CLOSE =
 *   closed, SOFT_CLOSE = soft — the same rule number governance uses.
 *
 * Read-only, RLS-scoped (runs as the user); no permission beyond sign-in — it exposes no
 * figures, only the calendar. Degrades: a failed close read returns closedThrough null.
 */

const query = z.object({
  location_id: z.string().optional(),
  location_ids: z.string().optional(),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface FiscalPeriodRow {
  id: string;
  location_id: string;
  period_year: number;
  period_month: number;
  status: string;
}

export const GET = apiQueryHandler(query, async (q, ctx) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  const { supabase, orgId } = ctx;

  const locationIds = [
    ...(q.location_id && q.location_id !== 'all' ? [q.location_id] : []),
    ...(q.location_ids?.split(',') ?? []),
  ]
    .map((s) => s.trim())
    .filter((s) => UUID_RE.test(s));

  const [today, org] = await Promise.all([
    getOrgToday(supabase, orgId),
    supabase.schema('core').from('organizations').select('fiscal_year_start_month').eq('id', orgId).maybeSingle(),
  ]);
  const fyStartMonth = normalizeFyStart((org.data as { fiscal_year_start_month?: number | null } | null)?.fiscal_year_start_month ?? 1);
  const currentMonth = currentMonthOf(today);
  const sinceYear = Number(currentMonth.slice(0, 4)) - 4;

  let closedThrough: string | null = null;
  let months: Record<string, string> = {};
  let companies = 0;
  const { data, error } = await fetchAll<FiscalPeriodRow>(
    () => {
      let fq = supabase
        .from('fiscal_periods')
        .select('id, location_id, period_year, period_month, status')
        .eq('org_id', orgId)
        .gte('period_year', sinceYear);
      if (locationIds.length === 1) fq = fq.eq('location_id', locationIds[0]);
      else if (locationIds.length > 1) fq = fq.in('location_id', locationIds);
      return fq;
    },
    { label: 'period context fiscal_periods' },
  );
  if (!error && data) {
    const rows: PeriodStatusRow[] = data.map((r) => ({
      locationId: r.location_id,
      year: Number(r.period_year),
      month: Number(r.period_month),
      status: r.status,
    }));
    const summary = summarizeClose(rows);
    closedThrough = summary.closedThrough;
    months = summary.months;
    companies = summary.companies;
  }

  return NextResponse.json({
    data: { fyStartMonth, today, currentMonth, closedThrough, months, companies, closeReadFailed: Boolean(error) },
  });
});
