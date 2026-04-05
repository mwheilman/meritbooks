import { NextResponse } from 'next/server';
import { apiQueryHandler, apiHandler } from '@/lib/api-handler';
import { z } from 'zod';

const jobListSchema = z.object({
  status: z.enum(['all', 'ACTIVE', 'BID', 'COMPLETE', 'CLOSED', 'ON_HOLD', 'CANCELLED']).optional(),
  location_id: z.string().uuid().optional(),
  search: z.string().max(200).optional(),
  page: z.string().regex(/^\d+$/).optional(),
  per_page: z.string().regex(/^\d+$/).optional(),
});

function calcEstimatedRevenue(j: any): number {
  const contract = Number(j.contract_amount_cents ?? 0);
  const estimated = Number(j.estimated_cost_cents ?? 0);
  const markup = Number(j.markup_pct ?? 0);
  const retainer = Number(j.monthly_retainer_cents ?? 0);
  const hourlyRate = Number(j.hourly_rate_cents ?? 0);
  const budgetHours = Number(j.budget_hours ?? 0);

  if (j.estimated_revenue_cents) return Number(j.estimated_revenue_cents);

  switch (j.pricing_model) {
    case 'COST_PLUS':
      return estimated > 0 ? Math.round(estimated * (1 + markup / 100)) : contract;
    case 'TIME_AND_MATERIALS':
    case 'HOURLY':
      return budgetHours > 0 && hourlyRate > 0
        ? Math.round(budgetHours * hourlyRate * (1 + markup / 100))
        : contract;
    case 'RETAINER':
    case 'SUBSCRIPTION': {
      if (retainer > 0 && j.service_start_date && j.service_end_date) {
        const start = new Date(j.service_start_date);
        const end = new Date(j.service_end_date);
        const months = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24 * 30.44)));
        return retainer * months;
      }
      return retainer * 12; // default to annual if no dates
    }
    default:
      return contract;
  }
}

function calcPctComplete(j: any): number {
  if (j.pct_complete != null && j.pct_complete > 0) return Number(j.pct_complete);

  switch (j.rev_rec_method) {
    case 'PCT_COSTS_INCURRED': {
      const est = Number(j.estimated_cost_cents ?? 0);
      const act = Number(j.actual_cost_cents ?? 0);
      return est > 0 ? Math.round((act / est) * 10000) / 100 : 0;
    }
    case 'MILESTONE': {
      const total = Number(j.total_milestones ?? 0);
      const done = Number(j.completed_milestones ?? 0);
      return total > 0 ? Math.round((done / total) * 10000) / 100 : 0;
    }
    case 'RATABLY':
    case 'SUBSCRIPTION': {
      if (j.service_start_date && j.service_end_date) {
        const start = new Date(j.service_start_date).getTime();
        const end = new Date(j.service_end_date).getTime();
        const now = Date.now();
        if (now >= end) return 100;
        if (now <= start) return 0;
        return Math.round(((now - start) / (end - start)) * 10000) / 100;
      }
      return 0;
    }
    case 'AS_BILLED': {
      const budgetHrs = Number(j.budget_hours ?? 0);
      const actualHrs = Number(j.actual_hours ?? 0);
      return budgetHrs > 0 ? Math.round((actualHrs / budgetHrs) * 10000) / 100 : 0;
    }
    default:
      return Number(j.pct_complete ?? 0);
  }
}

export const GET = apiQueryHandler(
  jobListSchema,
  async (params, ctx) => {
    const page = parseInt(params.page ?? '1', 10);
    const perPage = Math.min(parseInt(params.per_page ?? '50', 10), 100);
    const offset = (page - 1) * perPage;

    let query = ctx.supabase
      .from('jobs')
      .select(`
        id, job_number, name, description, customer_name, job_type, status,
        pricing_model, markup_pct,
        contract_amount_cents, original_contract_cents, approved_co_cents,
        estimated_cost_cents, estimated_revenue_cents,
        budget_labor_cents, budget_materials_cents, budget_subcontractor_cents, budget_other_cents,
        actual_cost_cents, actual_labor_cents, actual_materials_cents, actual_subcontractor_cents, actual_other_cents,
        billed_to_date_cents, retainage_held_cents, retainage_pct,
        actual_revenue_cents, pct_complete, revenue_recognized_cents, rev_rec_method,
        monthly_retainer_cents, service_start_date, service_end_date, billing_frequency,
        hourly_rate_cents, budget_hours, actual_hours,
        total_milestones, completed_milestones,
        start_date, estimated_completion_date, actual_completion_date,
        job_site_city, job_site_state, superintendent, project_manager,
        is_taxable, tax_rate_pct, notes,
        external_project_id, external_source, created_at,
        location:locations!jobs_location_id_fkey(id, name, short_code),
        job_phases(id),
        change_orders(id, amount_cents, status)
      `, { count: 'exact' });

    if (params.location_id) query = query.eq('location_id', params.location_id);
    if (params.status && params.status !== 'all') query = query.eq('status', params.status);
    if (params.search && params.search.trim().length > 0) {
      const term = params.search.trim();
      query = query.or(`job_number.ilike.%${term}%,name.ilike.%${term}%,customer_name.ilike.%${term}%`);
    }

    query = query.order('created_at', { ascending: false }).range(offset, offset + perPage - 1);
    const { data, error, count } = await query;

    if (error) {
      return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
    }

    const rows = (data ?? []).map((j: any) => {
      const contract = Number(j.contract_amount_cents ?? 0);
      const estimated = Number(j.estimated_cost_cents ?? 0);
      const actual = Number(j.actual_cost_cents ?? 0);
      const billed = Number(j.billed_to_date_cents ?? 0);

      const estimatedRevenue = calcEstimatedRevenue(j);
      const pctComplete = calcPctComplete(j);
      const profitMarginPct = estimatedRevenue > 0 ? Math.round(((estimatedRevenue - estimated) / estimatedRevenue) * 10000) / 100 : 0;
      const costPctOfBudget = estimated > 0 ? Math.round((actual / estimated) * 10000) / 100 : 0;
      const isOverBudget = estimated > 0 && actual > estimated;
      const earned = Math.round(estimatedRevenue * (pctComplete / 100));
      const wipVariance = billed - earned;

      const isService = ['RETAINER', 'SUBSCRIPTION', 'HOURLY'].includes(j.pricing_model);
      const changeOrders = j.change_orders ?? [];
      const pendingCOs = changeOrders.filter((co: any) => co.status === 'PENDING');

      return {
        ...j,
        change_orders: undefined,
        phaseCount: (j.job_phases ?? []).length,
        estimatedRevenueCents: estimatedRevenue,
        computedPctComplete: pctComplete,
        profitMarginPct, costPctOfBudget, isOverBudget,
        earnedCents: earned, wipVarianceCents: wipVariance,
        wipStatus: Math.abs(wipVariance) < 1000 ? 'ON_TRACK' : wipVariance > 0 ? 'OVERBILLED' : 'UNDERBILLED',
        isErpSynced: !!j.external_source,
        isService,
        changeOrderCount: changeOrders.length,
        pendingCOCount: pendingCOs.length,
      };
    });

    const countStatuses = ['ACTIVE', 'BID', 'COMPLETE', 'ON_HOLD'] as const;
    const statusCounts: Record<string, number> = {};
    for (const s of countStatuses) {
      let q = ctx.supabase.from('jobs').select('id', { count: 'exact', head: true }).eq('status', s);
      if (params.location_id) q = q.eq('location_id', params.location_id);
      const { count: c } = await q;
      statusCounts[s] = c ?? 0;
    }
    statusCounts['all'] = Object.values(statusCounts).reduce((a, b) => a + b, 0);

    const activeJobs = rows.filter((j: any) => j.status === 'ACTIVE');
    return NextResponse.json({
      data: rows,
      counts: statusCounts,
      summary: {
        totalContractCents: activeJobs.reduce((s: number, j: any) => s + Number(j.contract_amount_cents ?? 0), 0),
        totalEstRevCents: activeJobs.reduce((s: number, j: any) => s + (j.estimatedRevenueCents ?? 0), 0),
        totalActualCents: activeJobs.reduce((s: number, j: any) => s + Number(j.actual_cost_cents ?? 0), 0),
        totalBilledCents: activeJobs.reduce((s: number, j: any) => s + Number(j.billed_to_date_cents ?? 0), 0),
        overBudgetCount: activeJobs.filter((j: any) => j.isOverBudget).length,
        activeCount: activeJobs.length,
        serviceCount: activeJobs.filter((j: any) => j.isService).length,
        projectCount: activeJobs.filter((j: any) => !j.isService).length,
        erpSyncedCount: rows.filter((j: any) => j.isErpSynced).length,
      },
      pagination: { page, per_page: perPage, total: count ?? 0, total_pages: Math.ceil((count ?? 0) / perPage) },
    });
  }
);

// ===== POST — Create Job =====

const createJobSchema = z.object({
  location_id: z.string().uuid(),
  job_number: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  customer_name: z.string().max(200).optional(),
  customer_id: z.string().uuid().optional(),
  job_type: z.enum(['CONSTRUCTION', 'HVAC', 'CABINETRY', 'SERVICE', 'MAINTENANCE', 'OTHER']).optional(),
  status: z.enum(['BID', 'ACTIVE']).default('ACTIVE'),
  pricing_model: z.enum(['FIXED_PRICE', 'COST_PLUS', 'TIME_AND_MATERIALS', 'UNIT_PRICE', 'RETAINER', 'SUBSCRIPTION', 'HOURLY']).default('FIXED_PRICE'),
  markup_pct: z.number().min(0).max(100).default(0),
  contract_amount_cents: z.number().int().min(0).optional(),
  estimated_cost_cents: z.number().int().min(0).optional(),
  estimated_revenue_cents: z.number().int().min(0).optional(),
  budget_labor_cents: z.number().int().min(0).default(0),
  budget_materials_cents: z.number().int().min(0).default(0),
  budget_subcontractor_cents: z.number().int().min(0).default(0),
  budget_other_cents: z.number().int().min(0).default(0),
  retainage_pct: z.number().min(0).max(100).default(0),
  monthly_retainer_cents: z.number().int().min(0).optional(),
  service_start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  service_end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  billing_frequency: z.enum(['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUALLY', 'ONE_TIME']).default('MONTHLY'),
  hourly_rate_cents: z.number().int().min(0).optional(),
  budget_hours: z.number().min(0).optional(),
  total_milestones: z.number().int().min(0).optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  estimated_completion_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  rev_rec_method_override: z.enum(['PCT_COSTS_INCURRED', 'PCT_COMPLETE', 'COMPLETED_CONTRACT', 'POINT_OF_SALE', 'RATABLY', 'AS_BILLED', 'MILESTONE', 'SUBSCRIPTION']).optional(),
  job_site_address: z.string().max(200).optional(),
  job_site_city: z.string().max(100).optional(),
  job_site_state: z.string().max(2).optional(),
  job_site_zip: z.string().max(10).optional(),
  superintendent: z.string().max(100).optional(),
  project_manager: z.string().max(100).optional(),
  is_taxable: z.boolean().default(false),
  tax_jurisdiction: z.string().max(100).optional(),
  tax_rate_pct: z.number().min(0).max(20).default(0),
  notes: z.string().max(2000).optional(),
  external_project_id: z.string().max(200).optional(),
  external_source: z.string().max(50).optional(),
  phases: z.array(z.object({
    phase_code: z.string().min(1).max(20),
    name: z.string().min(1).max(200),
    budget_cents: z.number().int().min(0).default(0),
  })).optional(),
});

export const POST = apiHandler(
  createJobSchema,
  async (body, ctx) => {
    const orgId = ctx.orgId ?? '';

    const { data: location } = await ctx.supabase
      .from('locations')
      .select('rev_rec_method')
      .eq('id', body.location_id)
      .single();

    // Smart default: service pricing gets service rev rec, project pricing gets project rev rec
    let revRecMethod = body.rev_rec_method_override;
    if (!revRecMethod) {
      switch (body.pricing_model) {
        case 'RETAINER': revRecMethod = 'RATABLY'; break;
        case 'SUBSCRIPTION': revRecMethod = 'SUBSCRIPTION'; break;
        case 'HOURLY': revRecMethod = 'AS_BILLED'; break;
        case 'TIME_AND_MATERIALS': revRecMethod = 'AS_BILLED'; break;
        default: revRecMethod = location?.rev_rec_method ?? 'COMPLETED_CONTRACT';
      }
    }

    // Validate per method
    if ((revRecMethod === 'PCT_COSTS_INCURRED' || revRecMethod === 'PCT_COMPLETE') && !body.estimated_cost_cents) {
      return NextResponse.json({ error: `${revRecMethod} requires estimated cost`, code: 'VALIDATION_ERROR' }, { status: 422 });
    }
    if (revRecMethod === 'RATABLY' && !body.monthly_retainer_cents) {
      return NextResponse.json({ error: 'RATABLY method requires a monthly retainer amount', code: 'VALIDATION_ERROR' }, { status: 422 });
    }
    if (revRecMethod === 'MILESTONE' && !body.total_milestones) {
      return NextResponse.json({ error: 'MILESTONE method requires total milestone count', code: 'VALIDATION_ERROR' }, { status: 422 });
    }

    // Calculate estimated revenue
    const jobData: any = {
      ...body,
      org_id: orgId,
      rev_rec_method: revRecMethod,
      original_contract_cents: body.contract_amount_cents ?? null,
    };
    const estimatedRevenue = body.estimated_revenue_cents ?? calcEstimatedRevenue(jobData);

    const { data: job, error: jobError } = await ctx.supabase
      .from('jobs')
      .insert({
        org_id: orgId,
        location_id: body.location_id,
        job_number: body.job_number,
        name: body.name,
        description: body.description ?? null,
        customer_name: body.customer_name ?? null,
        customer_id: body.customer_id ?? null,
        job_type: body.job_type ?? null,
        status: body.status,
        pricing_model: body.pricing_model,
        markup_pct: body.markup_pct,
        contract_amount_cents: body.contract_amount_cents ?? null,
        original_contract_cents: body.contract_amount_cents ?? null,
        estimated_cost_cents: body.estimated_cost_cents ?? null,
        estimated_revenue_cents: estimatedRevenue ?? null,
        budget_labor_cents: body.budget_labor_cents,
        budget_materials_cents: body.budget_materials_cents,
        budget_subcontractor_cents: body.budget_subcontractor_cents,
        budget_other_cents: body.budget_other_cents,
        retainage_pct: body.retainage_pct,
        monthly_retainer_cents: body.monthly_retainer_cents ?? null,
        service_start_date: body.service_start_date ?? null,
        service_end_date: body.service_end_date ?? null,
        billing_frequency: body.billing_frequency,
        hourly_rate_cents: body.hourly_rate_cents ?? null,
        budget_hours: body.budget_hours ?? null,
        total_milestones: body.total_milestones ?? null,
        start_date: body.start_date ?? null,
        estimated_completion_date: body.estimated_completion_date ?? null,
        rev_rec_method: revRecMethod,
        job_site_address: body.job_site_address ?? null,
        job_site_city: body.job_site_city ?? null,
        job_site_state: body.job_site_state ?? null,
        job_site_zip: body.job_site_zip ?? null,
        superintendent: body.superintendent ?? null,
        project_manager: body.project_manager ?? null,
        is_taxable: body.is_taxable,
        tax_jurisdiction: body.tax_jurisdiction ?? null,
        tax_rate_pct: body.tax_rate_pct,
        notes: body.notes ?? null,
        external_project_id: body.external_project_id ?? null,
        external_source: body.external_source ?? null,
      })
      .select('id, job_number')
      .single();

    if (jobError) {
      if (jobError.code === '23505') {
        return NextResponse.json({ error: `Job number ${body.job_number} already exists`, code: 'DUPLICATE' }, { status: 409 });
      }
      return NextResponse.json({ error: jobError.message, code: 'CREATE_ERROR' }, { status: 500 });
    }

    if (body.phases && body.phases.length > 0 && job) {
      await ctx.supabase.from('job_phases').insert(
        body.phases.map((p, i) => ({
          org_id: orgId, job_id: job.id,
          phase_code: p.phase_code, name: p.name,
          budget_cents: p.budget_cents, display_order: i + 1,
        }))
      );
    }

    await ctx.supabase.from('audit_log').insert({
      org_id: orgId, table_name: 'jobs', record_id: job!.id,
      action: 'INSERT', user_id: ctx.userId,
      new_value: JSON.stringify({
        job_number: body.job_number, pricing_model: body.pricing_model,
        rev_rec_method: revRecMethod, markup_pct: body.markup_pct,
      }),
    });

    return NextResponse.json({
      success: true, job_id: job!.id, job_number: job!.job_number,
      pricing_model: body.pricing_model, rev_rec_method: revRecMethod,
      estimated_revenue_cents: estimatedRevenue,
    }, { status: 201 });
  }
);
