import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';

// /api/allowances — owner allowances and their drawdown.
//   GET  ?jobId=<uuid>  → proj.v_allowance_status list for one job (no guard).
//   POST  {jobId, description, allowanceCents, costCodeId?} → create an OPEN
//         allowance. guard ('proj_contracts','edit').
//
// Both run through the RLS-scoped ctx.supabase so org isolation is enforced at
// the DB. Money is bigint cents.

const querySchema = z.object({
  jobId: z.string().uuid(),
});

const createSchema = z.object({
  jobId: z.string().uuid(),
  description: z.string().trim().min(1).max(500),
  allowanceCents: z.number().int().nonnegative(),
  costCodeId: z.string().uuid().optional(),
});

// GET — list allowances (with computed remaining_cents / pct_consumed) for a job.
export async function GET(request: Request): Promise<NextResponse> {
  return apiQueryHandler(querySchema, async (params, ctx) => {
    const { data, error } = await ctx.supabase
      .schema('proj')
      .from('v_allowance_status')
      .select(
        'id, job_id, cost_code_id, description, status, allowance_cents, consumed_cents, remaining_cents, pct_consumed',
      )
      .eq('job_id', params.jobId)
      .order('description', { ascending: true });

    if (error) {
      return NextResponse.json({ error: error.message, code: 'QUERY_FAILED' }, { status: 500 });
    }
    return NextResponse.json({ allowances: data ?? [] });
  })(request);
}

// POST — create an allowance. org_id defaults via the table default
// (get_org_id()); created_by carries the caller.
export async function POST(request: Request): Promise<NextResponse> {
  return apiHandler(createSchema, async (body, ctx) => {
    const guard = await requirePermission(ctx, 'proj_contracts', 'edit');
    if (!guard.ok) return guard.response;

    const { data, error } = await ctx.supabase
      .schema('proj')
      .from('allowances')
      .insert({
        job_id: body.jobId,
        description: body.description,
        allowance_cents: body.allowanceCents,
        cost_code_id: body.costCodeId ?? null,
        created_by: ctx.userId,
      })
      .select('id')
      .single();

    if (error) {
      // RLS / FK violations surface as the DB message.
      return NextResponse.json({ error: error.message, code: 'CREATE_FAILED' }, { status: 422 });
    }
    return NextResponse.json({ ok: true, id: data.id });
  })(request);
}
