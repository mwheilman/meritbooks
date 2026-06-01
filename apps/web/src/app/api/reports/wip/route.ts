export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';

type Supa = ReturnType<typeof createAdminSupabase>;

async function getOrgId(supabase: Supa): Promise<string | null> {
  const { data } = await supabase.schema('core').from('organizations').select('id').limit(1).single();
  return (data as { id: string } | null)?.id ?? null;
}

/**
 * GET /api/reports/wip — Work-in-Progress schedule.
 * For each open job: earned revenue (estimated revenue × % complete) vs amount
 * billed to date, surfacing over/under-billing. % complete falls back to
 * cost-to-cost when not explicitly set.
 */
export async function GET(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();
  const orgId = await getOrgId(supabase);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const locIds = new URL(request.url).searchParams.get('location_ids');

  let query = supabase
    .schema('core').from('jobs')
    .select(`
      id, job_number, name, status,
      contract_amount_cents, estimated_revenue_cents, estimated_cost_cents,
      budget_labor_cents, budget_materials_cents, budget_subcontractor_cents, budget_other_cents,
      actual_cost_cents, billed_to_date_cents, pct_complete,
      location:locations!jobs_location_id_fkey(short_code)
    `)
    .in('status', ['ACTIVE', 'COMPLETE', 'ON_HOLD'])
    .order('job_number');

  if (locIds) {
    const ids = locIds.split(',').filter(Boolean);
    if (ids.length > 0) query = query.in('location_id', ids);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let totEarned = 0, totBilled = 0, totOver = 0, totUnder = 0, totContract = 0, totActual = 0;

  const rows = (data ?? []).map((j: Record<string, any>) => {
    const contract = Number(j.contract_amount_cents ?? 0);
    const estRevenue = Number(j.estimated_revenue_cents ?? 0) || contract;
    const budgetSum = Number(j.budget_labor_cents ?? 0) + Number(j.budget_materials_cents ?? 0) + Number(j.budget_subcontractor_cents ?? 0) + Number(j.budget_other_cents ?? 0);
    const estCost = Number(j.estimated_cost_cents ?? 0) || budgetSum;
    const actualCost = Number(j.actual_cost_cents ?? 0);
    let pct = Number(j.pct_complete ?? 0);
    if (!(pct > 0) && estCost > 0) pct = Math.min(100, Math.round((actualCost / estCost) * 1000) / 10);
    const earned = Math.round(estRevenue * (pct / 100));
    const billed = Number(j.billed_to_date_cents ?? 0);
    const overbilled = Math.max(0, billed - earned);
    const underbilled = Math.max(0, earned - billed);

    totEarned += earned; totBilled += billed; totOver += overbilled; totUnder += underbilled;
    totContract += estRevenue; totActual += actualCost;

    return {
      company: j.location?.short_code ?? '--',
      jobNumber: j.job_number,
      jobName: j.name,
      status: j.status,
      contractCents: estRevenue,
      estimatedCostCents: estCost,
      actualCostCents: actualCost,
      pctComplete: pct,
      earnedRevenueCents: earned,
      billedToDateCents: billed,
      overbilledCents: overbilled,
      underbilledCents: underbilled,
    };
  });

  return NextResponse.json({
    data: rows,
    totals: {
      jobs: rows.length,
      estimatedRevenueCents: totContract,
      actualCostCents: totActual,
      earnedRevenueCents: totEarned,
      billedToDateCents: totBilled,
      overbilledCents: totOver,
      underbilledCents: totUnder,
    },
  });
}
