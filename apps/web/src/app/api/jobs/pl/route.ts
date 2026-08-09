export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { apiQueryHandler, type ApiContext } from '@/lib/api-handler';
import {
  computeJobPL,
  computeJobPLPortfolio,
  type JobPLInput,
  type JobPLCategoryInput,
  type JobPLOptions,
} from '@/lib/jobs/job-pl';
import type { EacMethod } from '@/lib/jobcost/eac';

/**
 * GET /api/jobs/pl — contractor Job P&L + portfolio WIP schedule.
 *
 * Read-only, RLS-scoped (tenant isolation enforced by the DB, not by this route
 * remembering to filter). Two shapes:
 *   • ?job_id=<uuid>   → one job's full P&L (revenue, costs by category, EAC,
 *                        earned revenue, over/under-billing, margin, GL tie-out)
 *   • (no job_id)      → portfolio schedule: every open job + roll-up totals
 *
 * Every cent is authored in lib/jobs/job-pl.ts, which composes the two pure,
 * unit-tested primitives (lib/jobcost/wip.ts + lib/jobcost/eac.ts). This route
 * only fetches the inputs and threads open commitments + the GL cost tie. It
 * never authors a figure (canon §3).
 */

const OPEN_STATUSES = ['ACTIVE', 'ON_HOLD', 'COMPLETE'];

const querySchema = z.object({
  job_id: z.string().uuid().optional(),
  method: z.enum(['COST_TO_COST', 'COMMITMENTS', 'PROGRESS']).optional(),
  location_ids: z.string().max(2000).optional(),
  tolerance_cents: z.coerce.number().int().min(0).optional(),
  fade_bps: z.coerce.number().int().min(0).max(10000).optional(),
});
type Query = z.infer<typeof querySchema>;

const JOB_SELECT = `
  id, job_number, name, status,
  contract_amount_cents, original_contract_cents, approved_co_cents, estimated_revenue_cents,
  estimated_cost_cents,
  budget_labor_cents, budget_materials_cents, budget_subcontractor_cents, budget_other_cents,
  actual_cost_cents, actual_labor_cents, actual_materials_cents, actual_subcontractor_cents, actual_other_cents,
  billed_to_date_cents, retainage_held_cents, revenue_recognized_cents, pct_complete,
  location:locations!jobs_location_id_fkey(short_code)
`;

interface JobRow {
  id: string;
  job_number: string;
  name: string;
  status: string;
  contract_amount_cents: number | null;
  original_contract_cents: number | null;
  approved_co_cents: number | null;
  estimated_revenue_cents: number | null;
  estimated_cost_cents: number | null;
  budget_labor_cents: number | null;
  budget_materials_cents: number | null;
  budget_subcontractor_cents: number | null;
  budget_other_cents: number | null;
  actual_cost_cents: number | null;
  actual_labor_cents: number | null;
  actual_materials_cents: number | null;
  actual_subcontractor_cents: number | null;
  actual_other_cents: number | null;
  billed_to_date_cents: number | null;
  retainage_held_cents: number | null;
  revenue_recognized_cents: number | null;
  pct_complete: number | null;
  location: { short_code: string | null } | { short_code: string | null }[] | null;
}

function num(x: number | null | undefined): number {
  return Number(x ?? 0);
}

function shortCode(loc: JobRow['location']): string {
  const l = Array.isArray(loc) ? loc[0] : loc;
  return l?.short_code ?? '--';
}

function categoriesOf(j: JobRow): JobPLCategoryInput[] {
  return [
    { key: 'LABOR', label: 'Labor', budgetCents: num(j.budget_labor_cents), actualCents: num(j.actual_labor_cents) },
    { key: 'MATERIALS', label: 'Materials', budgetCents: num(j.budget_materials_cents), actualCents: num(j.actual_materials_cents) },
    { key: 'SUBCONTRACTOR', label: 'Subcontractor', budgetCents: num(j.budget_subcontractor_cents), actualCents: num(j.actual_subcontractor_cents) },
    { key: 'OTHER', label: 'Other', budgetCents: num(j.budget_other_cents), actualCents: num(j.actual_other_cents) },
  ];
}

/** Build the deterministic Job P&L input for a job row + its seam figures. */
function toJobPLInput(
  j: JobRow,
  committedOpenCents: number,
  glPostedCostsCents: number,
): JobPLInput {
  const budgetSum =
    num(j.budget_labor_cents) +
    num(j.budget_materials_cents) +
    num(j.budget_subcontractor_cents) +
    num(j.budget_other_cents);
  const contract = num(j.contract_amount_cents) || num(j.estimated_revenue_cents);
  const pct = num(j.pct_complete);
  return {
    jobId: j.id,
    jobNumber: j.job_number,
    jobName: j.name,
    status: j.status,
    company: shortCode(j.location),
    contractValueCents: contract,
    originalContractCents: j.original_contract_cents != null ? num(j.original_contract_cents) : null,
    approvedCoCents: num(j.approved_co_cents),
    estimatedCostCents: num(j.estimated_cost_cents) || budgetSum,
    originalBudgetCents: budgetSum || num(j.estimated_cost_cents),
    costsToDateCents: num(j.actual_cost_cents),
    committedOpenCents,
    billedToDateCents: num(j.billed_to_date_cents),
    revenueRecognizedCents: num(j.revenue_recognized_cents),
    retainageHeldCents: num(j.retainage_held_cents),
    glPostedCostsCents,
    pctCompleteOverride: pct > 0 ? pct / 100 : null,
    categories: categoriesOf(j),
  };
}

/** Sum PENDING (committed, not yet cleared) job-cost attributions per job. */
async function fetchCommittedOpen(
  supabase: SupabaseClient,
  orgId: string,
  jobIds: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (jobIds.length === 0) return map;
  const { data } = await supabase
    .from('job_cost_attributions')
    .select('job_id, amount_cents, lifecycle')
    .eq('org_id', orgId)
    .eq('lifecycle', 'PENDING')
    .in('job_id', jobIds);
  for (const a of (data ?? []) as { job_id: string; amount_cents: number }[]) {
    map.set(a.job_id, (map.get(a.job_id) ?? 0) + Number(a.amount_cents));
  }
  return map;
}

/** Sum GL-posted job-cost bridge rows per job — the cost-to-date GL tie. */
async function fetchGlPostedCosts(
  supabase: SupabaseClient,
  orgId: string,
  jobIds: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (jobIds.length === 0) return map;
  const { data } = await supabase
    .from('job_cost_entries')
    .select('job_id, amount_cents')
    .eq('org_id', orgId)
    .in('job_id', jobIds);
  for (const e of (data ?? []) as { job_id: string; amount_cents: number }[]) {
    map.set(e.job_id, (map.get(e.job_id) ?? 0) + Number(e.amount_cents));
  }
  return map;
}

export const GET = apiQueryHandler(querySchema, async (q: Query, ctx: ApiContext) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const method: EacMethod = q.method ?? 'COMMITMENTS';
  const opts: JobPLOptions = { eacMethod: method };
  if (q.tolerance_cents != null) opts.toleranceCents = q.tolerance_cents;
  if (q.fade_bps != null) opts.fadeThresholdBps = q.fade_bps;

  // ── Single job P&L ────────────────────────────────────────────────────────────
  if (q.job_id) {
    const { data: job, error } = await ctx.supabase
      .schema('core')
      .from('jobs')
      .select(JOB_SELECT)
      .eq('id', q.job_id)
      .single();
    if (error || !job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

    const j = job as unknown as JobRow;
    const [committed, glPosted] = await Promise.all([
      fetchCommittedOpen(ctx.supabase, ctx.orgId, [j.id]),
      fetchGlPostedCosts(ctx.supabase, ctx.orgId, [j.id]),
    ]);
    const pl = computeJobPL(toJobPLInput(j, committed.get(j.id) ?? 0, glPosted.get(j.id) ?? 0), opts);
    return NextResponse.json({ method, pl });
  }

  // ── Portfolio schedule ──────────────────────────────────────────────────────────
  let query = ctx.supabase
    .schema('core')
    .from('jobs')
    .select(JOB_SELECT)
    .in('status', OPEN_STATUSES)
    .order('job_number');
  if (q.location_ids) {
    const ids = q.location_ids.split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length > 0) query = query.in('location_id', ids);
  }
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as unknown as JobRow[];
  const jobIds = rows.map((r) => r.id);
  const [committed, glPosted] = await Promise.all([
    fetchCommittedOpen(ctx.supabase, ctx.orgId, jobIds),
    fetchGlPostedCosts(ctx.supabase, ctx.orgId, jobIds),
  ]);

  const portfolio = computeJobPLPortfolio(
    rows.map((j) => toJobPLInput(j, committed.get(j.id) ?? 0, glPosted.get(j.id) ?? 0)),
    opts,
  );
  return NextResponse.json({ method, ...portfolio });
});
