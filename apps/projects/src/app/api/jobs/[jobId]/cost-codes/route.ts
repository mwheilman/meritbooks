import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';

// POST /api/jobs/[jobId]/cost-codes — create a job-scoped cost code.
// org_id is defaulted by the DB (public.get_org_id()); job_id comes from the
// route param. RLS (proj.cost_codes org_isolation) enforces tenant scope.
const bodySchema = z.object({
  code: z.string().trim().min(1, 'Code is required').max(64, 'Code is too long'),
  name: z.string().trim().min(1, 'Name is required').max(200, 'Name is too long'),
  cost_type: z
    .enum(['LABOR', 'MATERIALS', 'SUBCONTRACTOR', 'EQUIPMENT', 'OTHER'])
    .optional(),
});

export function POST(request: Request, { params }: { params: { jobId: string } }) {
  return apiHandler(bodySchema, async (body, ctx) => {
    const guard = await requirePermission(ctx, 'proj_jobs', 'edit');
    if (!guard.ok) return guard.response;

    const { data, error } = await ctx.supabase
      .schema('proj')
      .from('cost_codes')
      .insert({
        job_id: params.jobId,
        code: body.code,
        name: body.name,
        cost_type: body.cost_type ?? null,
      })
      .select('id, code, name, cost_type')
      .single();

    if (error) {
      const duplicate = error.code === '23505';
      return NextResponse.json(
        {
          error: duplicate ? 'A cost code with that code already exists on this job.' : error.message,
          code: duplicate ? 'DUPLICATE_COST_CODE' : 'DB_ERROR',
        },
        { status: duplicate ? 409 : 400 },
      );
    }

    return NextResponse.json({ costCode: data }, { status: 201 });
  })(request);
}
