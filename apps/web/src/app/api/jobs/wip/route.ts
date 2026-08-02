export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiQueryHandler, type ApiContext } from '@/lib/api-handler';
import { computeWipSchedule, type WipJobInput } from '@/lib/jobcost/wip';

/**
 * GET /api/jobs/wip — contractor Work-in-Progress over/under-billing schedule.
 *
 * Read-only, RLS-scoped. For every open job it computes earned revenue
 * (contract × %-complete) vs billed-to-date and surfaces billings in excess of
 * costs & earnings (over-billing → liability) or costs & earnings in excess of
 * billings (under-billing → contract asset), plus the portfolio roll-up. Every
 * figure is computed deterministically in lib/jobcost/wip.ts.
 */

const OPEN_STATUSES = ['ACTIVE', 'ON_HOLD', 'COMPLETE'];

const querySchema = z.object({
  location_ids: z.string().max(2000).optional(),
  tolerance_cents: z.coerce.number().int().min(0).optional(),
});
type Query = z.infer<typeof querySchema>;

const JOB_SELECT = `
  id, job_number, name, status,
  contract_amount_cents, estimated_revenue_cents, estimated_cost_cents,
  budget_labor_cents, budget_materials_cents, budget_subcontractor_cents, budget_other_cents,
  actual_cost_cents, billed_to_date_cents, pct_complete,
  location:locations!jobs_location_id_fkey(short_code)
`;

interface JobRow {
  id: string;
  job_number: string;
  name: string;
  status: string;
  contract_amount_cents: number | null;
  estimated_revenue_cents: number | null;
  estimated_cost_cents: number | null;
  budget_labor_cents: number | null;
  budget_materials_cents: number | null;
  budget_subcontractor_cents: number | null;
  budget_other_cents: number | null;
  actual_cost_cents: number | null;
  billed_to_date_cents: number | null;
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

function toWipInput(j: JobRow): WipJobInput {
  const budgetSum =
    num(j.budget_labor_cents) +
    num(j.budget_materials_cents) +
    num(j.budget_subcontractor_cents) +
    num(j.budget_other_cents);
  const pct = num(j.pct_complete);
  return {
    jobId: j.id,
    jobNumber: j.job_number,
    jobName: j.name,
    status: j.status,
    company: shortCode(j.location),
    contractValueCents: num(j.contract_amount_cents) || num(j.estimated_revenue_cents),
    estimatedCostCents: num(j.estimated_cost_cents) || budgetSum,
    costsToDateCents: num(j.actual_cost_cents),
    billedToDateCents: num(j.billed_to_date_cents),
    pctCompleteOverride: pct > 0 ? pct / 100 : null,
  };
}

export const GET = apiQueryHandler(querySchema, async (q: Query, ctx: ApiContext) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

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
  const schedule = computeWipSchedule(
    rows.map(toWipInput),
    q.tolerance_cents != null ? { toleranceCents: q.tolerance_cents } : {},
  );

  return NextResponse.json(schedule);
});
