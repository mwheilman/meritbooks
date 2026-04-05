export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';

export async function GET(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();
  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get('location_id');

  let query = supabase.from('v_job_profitability').select('*');
  if (locationId) query = query.eq('location_id', locationId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
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
