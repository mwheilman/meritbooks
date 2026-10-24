export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { asOfMonth, governRoute } from '@/lib/reports/governance/route-guard';
import { getOrgToday } from '@/lib/dates/org-today';
import { fetchAll } from '@/lib/supabase/fetch-all';

export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase } = ctx;
  const { searchParams } = new URL(request.url);
  const locationIds = searchParams.get('location_ids');
  const locationId = searchParams.get('location_id');
  const locFilter = locationIds ? locationIds.split(',').filter(Boolean) : (locationId && locationId !== 'all' ? [locationId] : []);

  // Number governance: job revenue / cost to date — a balance as of today, so a non-finance caller needs every
  // month through the current one released (cumulative rule; the current month never is →
  // finance-only in practice). 403 NOT_RELEASED otherwise.
  const govToday = await getOrgToday(ctx.supabase, ctx.orgId);
  const gov = await governRoute({ supabase: ctx.supabase, orgId: ctx.orgId, userId: ctx.userId }, { months: [asOfMonth(govToday)], locationIds: locFilter, cumulative: true });
  if (gov instanceof NextResponse) return gov;

  // Paged: PostgREST caps a response at 1,000 rows.
  const buildQuery = () => {
    let query = supabase.from('v_job_profitability').select('*');
    if (locFilter.length === 1) query = query.eq('location_id', locFilter[0]);
    else if (locFilter.length > 1) query = query.in('location_id', locFilter);
    return query;
  };

  const { data, error } = await fetchAll(buildQuery, { orderBy: 'job_id', label: 'job-profitability v_job_profitability' });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ governance: gov.info,
    data: (data ?? []).map((r) => ({
      jobNumber: r.job_number, jobName: r.job_name, customerName: r.customer_name,
      status: r.status, locationName: r.location_name,
      contractCents: Number(r.contract_amount_cents ?? 0),
      estimatedCostCents: Number(r.estimated_cost_cents ?? 0),
      actualCostCents: Number(r.actual_cost_cents ?? 0),
      billedCents: Number(r.billed_to_date_cents ?? 0),
      pctComplete: Number(r.pct_complete ?? 0),
      marginPct: r.contract_amount_cents && r.actual_cost_cents
        ? Math.round((1 - Number(r.actual_cost_cents) / Number(r.contract_amount_cents)) * 100)
        : null,
      isOverBudget: r.estimated_cost_cents ? Number(r.actual_cost_cents ?? 0) > Number(r.estimated_cost_cents) : false,
    })),
  });
}
