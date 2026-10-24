export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { asOfMonth, governRoute } from '@/lib/reports/governance/route-guard';
import { fetchAll } from '@/lib/supabase/fetch-all';
import { getOrgToday } from '@/lib/dates/org-today';
import { agingBucketFor } from '@/lib/ar/overdue';

export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  // Buckets from due_date vs the ORG's today (the view's bucket uses UTC CURRENT_DATE).
  const today = await getOrgToday(supabase, orgId);
  const { searchParams } = new URL(request.url);
  const locationIds = searchParams.get('location_ids');
  const locationId = searchParams.get('location_id');
  const locFilter = locationIds ? locationIds.split(',').filter(Boolean) : (locationId && locationId !== 'all' ? [locationId] : []);

  // Number governance: open AP as of today — a balance as of today, so a non-finance caller needs every
  // month through the current one released (cumulative rule; the current month never is →
  // finance-only in practice). 403 NOT_RELEASED otherwise.
  const govToday = await getOrgToday(ctx.supabase, ctx.orgId);
  const gov = await governRoute({ supabase: ctx.supabase, orgId: ctx.orgId, userId: ctx.userId }, { months: [asOfMonth(govToday)], locationIds: locFilter, cumulative: true });
  if (gov instanceof NextResponse) return gov;

  // Paged: PostgREST caps a response at 1,000 rows.
  const buildQuery = () => {
    let query = supabase.from('v_ap_aging').select('*');
    if (locFilter.length === 1) query = query.eq('location_id', locFilter[0]);
    else if (locFilter.length > 1) query = query.in('location_id', locFilter);
    return query;
  };

  const { data, error } = await fetchAll(buildQuery, { orderBy: 'bill_id', label: 'ap-aging v_ap_aging' });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const buckets: Record<string, { count: number; totalCents: number }> = {
    CURRENT: { count: 0, totalCents: 0 }, '1-30': { count: 0, totalCents: 0 },
    '31-60': { count: 0, totalCents: 0 }, '61-90': { count: 0, totalCents: 0 },
    '90+': { count: 0, totalCents: 0 },
  };
  for (const row of data ?? []) {
    const b = agingBucketFor(row.due_date as string | null, today);
    buckets[b].count++; buckets[b].totalCents += Number(row.balance_cents ?? 0);
  }

  return NextResponse.json({ governance: gov.info,
    data: (data ?? []).map((r) => ({
      vendorName: r.vendor_name, billNumber: r.bill_number, billDate: r.bill_date,
      dueDate: r.due_date, totalCents: Number(r.total_cents ?? 0),
      paidCents: Number(r.amount_paid_cents ?? 0), balanceCents: Number(r.balance_cents ?? 0),
      agingBucket: agingBucketFor(r.due_date as string | null, today), locationName: r.location_name,
    })),
    buckets,
    totalOutstanding: Object.values(buckets).reduce((s, b) => s + b.totalCents, 0),
  });
}
