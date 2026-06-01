export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { z } from 'zod';

type Supa = ReturnType<typeof createAdminSupabase>;

async function getOrgId(supabase: Supa): Promise<string | null> {
  const { data } = await supabase.schema('core').from('organizations').select('id').limit(1).single();
  return (data as { id: string } | null)?.id ?? null;
}

const JOB_SELECT = `
  id, job_number, name, description, customer_name, job_type, status, archetype,
  pricing_model, markup_pct,
  contract_amount_cents, original_contract_cents, approved_co_cents,
  estimated_cost_cents, estimated_revenue_cents,
  budget_labor_cents, budget_materials_cents, budget_subcontractor_cents, budget_other_cents,
  actual_cost_cents, actual_labor_cents, actual_materials_cents, actual_subcontractor_cents, actual_other_cents,
  billed_to_date_cents, retainage_held_cents, retainage_pct,
  actual_revenue_cents, pct_complete, revenue_recognized_cents, rev_rec_method, rev_rec_method_override,
  rev_rec_last_run_on,
  start_date, estimated_completion_date, actual_completion_date,
  job_site_city, job_site_state, superintendent, project_manager,
  external_project_id, external_source, created_at,
  location:locations!jobs_location_id_fkey(id, name, short_code)
`;

interface CostEntry { id: string; amount_cents: number; entry_date: string; description: string | null; gl_entry_line_id: string | null; bill_line_id: string | null }

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();
  const orgId = await getOrgId(supabase);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { data: job, error } = await supabase
    .schema('core').from('jobs')
    .select(JOB_SELECT)
    .eq('id', params.id)
    .single();
  if (error || !job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  const j = job as Record<string, any>;

  // ── Budget vs actual by cost category (off the job record) ──
  const categories = [
    { key: 'LABOR', label: 'Labor', budget: Number(j.budget_labor_cents ?? 0), actual: Number(j.actual_labor_cents ?? 0) },
    { key: 'MATERIALS', label: 'Materials', budget: Number(j.budget_materials_cents ?? 0), actual: Number(j.actual_materials_cents ?? 0) },
    { key: 'SUBCONTRACTOR', label: 'Subcontractor', budget: Number(j.budget_subcontractor_cents ?? 0), actual: Number(j.actual_subcontractor_cents ?? 0) },
    { key: 'OTHER', label: 'Other', budget: Number(j.budget_other_cents ?? 0), actual: Number(j.actual_other_cents ?? 0) },
  ].map((c) => ({ ...c, variance: c.budget - c.actual, pctUsed: c.budget > 0 ? Math.round((c.actual / c.budget) * 1000) / 10 : null }));

  const budgetTotal = categories.reduce((s, c) => s + c.budget, 0);
  const actualTotal = Number(j.actual_cost_cents ?? 0) || categories.reduce((s, c) => s + c.actual, 0);
  const estimatedCost = Number(j.estimated_cost_cents ?? 0) || budgetTotal;

  // ── Committed vs cleared from the cost/billing seam (job_cost_attributions) ──
  const { data: attrs } = await supabase
    .from('job_cost_attributions')
    .select('lifecycle, cost_type, amount_cents')
    .eq('org_id', orgId)
    .eq('job_id', params.id);

  let committedCents = 0;
  let clearedCents = 0;
  const byType: Record<string, { committed: number; cleared: number }> = {};
  for (const a of (attrs ?? []) as { lifecycle: string; cost_type: string; amount_cents: number }[]) {
    const amt = Number(a.amount_cents);
    byType[a.cost_type] ??= { committed: 0, cleared: 0 };
    if (a.lifecycle === 'PENDING') { committedCents += amt; byType[a.cost_type].committed += amt; }
    else if (a.lifecycle === 'CLEARED') { clearedCents += amt; byType[a.cost_type].cleared += amt; }
  }

  // ── Cost ledger: job_cost_entries enriched with GL entry + bill source ──
  const { data: rawEntries } = await supabase
    .from('job_cost_entries')
    .select('id, amount_cents, entry_date, description, gl_entry_line_id, bill_line_id')
    .eq('org_id', orgId)
    .eq('job_id', params.id)
    .order('entry_date', { ascending: false })
    .limit(200);
  const entries = (rawEntries ?? []) as CostEntry[];

  // Resolve GL entry metadata via the line ids.
  const glLineIds = entries.map((e) => e.gl_entry_line_id).filter(Boolean) as string[];
  const glEntryByLine = new Map<string, { entry_number: string; source_module: string | null }>();
  if (glLineIds.length > 0) {
    const { data: glLines } = await supabase.from('gl_entry_lines').select('id, gl_entry_id').in('id', glLineIds);
    const entryIds = [...new Set((glLines ?? []).map((l) => (l as { gl_entry_id: string }).gl_entry_id))];
    const entryMeta = new Map<string, { entry_number: string; source_module: string | null }>();
    if (entryIds.length > 0) {
      const { data: glEntries } = await supabase.from('gl_entries').select('id, entry_number, source_module').in('id', entryIds);
      for (const ge of glEntries ?? []) entryMeta.set((ge as { id: string }).id, { entry_number: (ge as any).entry_number, source_module: (ge as any).source_module });
    }
    for (const l of glLines ?? []) {
      const meta = entryMeta.get((l as { gl_entry_id: string }).gl_entry_id);
      if (meta) glEntryByLine.set((l as { id: string }).id, meta);
    }
  }

  // Resolve bill numbers for entries tied to a bill line.
  const billLineIds = entries.map((e) => e.bill_line_id).filter(Boolean) as string[];
  const billByLine = new Map<string, string | null>();
  if (billLineIds.length > 0) {
    const { data: bl } = await supabase.from('bill_lines').select('id, bill_id').in('id', billLineIds);
    const billIds = [...new Set((bl ?? []).map((x) => (x as { bill_id: string }).bill_id))];
    const billNo = new Map<string, string | null>();
    if (billIds.length > 0) {
      const { data: bills } = await supabase.from('bills').select('id, bill_number').in('id', billIds);
      for (const b of bills ?? []) billNo.set((b as { id: string }).id, (b as { bill_number: string | null }).bill_number);
    }
    for (const x of bl ?? []) billByLine.set((x as { id: string }).id, billNo.get((x as { bill_id: string }).bill_id) ?? null);
  }

  const ledger = entries.map((e) => {
    const gl = e.gl_entry_line_id ? glEntryByLine.get(e.gl_entry_line_id) : undefined;
    const billNumber = e.bill_line_id ? billByLine.get(e.bill_line_id) : undefined;
    const source = billNumber ? `Bill ${billNumber}` : gl?.source_module ? gl.source_module.replace('_', ' ') : 'Manual';
    return {
      id: e.id,
      entry_date: e.entry_date,
      description: e.description,
      amount_cents: Number(e.amount_cents),
      source,
      entry_number: gl?.entry_number ?? null,
    };
  });

  // ── Change orders + phases ──
  const { data: changeOrders } = await supabase
    .from('change_orders')
    .select('id, co_number, description, amount_cents, status, created_at')
    .eq('job_id', params.id)
    .order('created_at', { ascending: false });

  const { data: phases } = await supabase
    .from('job_phases')
    .select('id, name, phase_order')
    .eq('job_id', params.id)
    .order('phase_order', { ascending: true });

  const estimatedRevenue = Number(j.estimated_revenue_cents ?? 0) || Number(j.contract_amount_cents ?? 0);
  const pctComplete = j.pct_complete != null && Number(j.pct_complete) > 0
    ? Number(j.pct_complete)
    : estimatedCost > 0 ? Math.round((actualTotal / estimatedCost) * 1000) / 10 : 0;
  const earnedCents = Math.round(estimatedRevenue * (pctComplete / 100));
  const billedCents = Number(j.billed_to_date_cents ?? 0);

  return NextResponse.json({
    job: j,
    metrics: {
      estimatedRevenueCents: estimatedRevenue,
      estimatedCostCents: estimatedCost,
      budgetTotalCents: budgetTotal,
      actualCostCents: actualTotal,
      committedCents,
      clearedCents,
      remainingBudgetCents: estimatedCost - actualTotal,
      pctComplete,
      pctBudgetUsed: estimatedCost > 0 ? Math.round((actualTotal / estimatedCost) * 1000) / 10 : null,
      earnedCents,
      billedCents,
      wipVarianceCents: billedCents - earnedCents,
      grossProfitCents: estimatedRevenue - estimatedCost,
      grossMarginPct: estimatedRevenue > 0 ? Math.round(((estimatedRevenue - estimatedCost) / estimatedRevenue) * 1000) / 10 : null,
      isOverBudget: estimatedCost > 0 && actualTotal > estimatedCost,
    },
    categories,
    costByType: byType,
    ledger,
    changeOrders: changeOrders ?? [],
    phases: phases ?? [],
  });
}

// PATCH /api/jobs/[id] — standalone direct entry of revenue-recognition inputs.
// Accounting keys contract value / estimate / % complete / method override straight
// onto core.jobs when Projects isn't present (contract §10). Books authors nothing
// here that a JOB_PROGRESS event wouldn't otherwise pin — same columns, manual path.
const revRecInputSchema = z.object({
  contract_amount_cents: z.number().int().min(0).optional(),
  estimated_cost_cents: z.number().int().min(0).optional(),
  pct_complete: z.number().min(0).max(100).optional(),
  rev_rec_method_override: z.enum([
    'PCT_COMPLETE', 'PCT_COSTS_INCURRED', 'COMPLETED_CONTRACT', 'MILESTONE',
    'POINT_OF_SALE', 'AS_BILLED', 'RATABLY', 'SUBSCRIPTION', 'CASH',
  ]).nullable().optional(),
}).refine((o) => Object.keys(o).length > 0, { message: 'No fields to update' });

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();
  const orgId = await getOrgId(supabase);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  let raw: unknown;
  try { raw = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const parsed = revRecInputSchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 422 });

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [k, v] of Object.entries(parsed.data)) patch[k] = v;

  const { error } = await supabase.schema('core').from('jobs').update(patch).eq('org_id', orgId).eq('id', params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: params.id });
}
