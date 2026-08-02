import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';

// POST /api/gates — create an external gate (permit / inspection / acceptance
// state machine) for a job. Defaults from the DB: status=PENDING and
// required/blocks_billing/blocks_close=true. org_id defaulted via get_org_id();
// RLS (proj.external_gates org_isolation) enforces tenant scope.
const bodySchema = z.object({
  job_id: z.string().uuid('A valid job is required'),
  gate_type: z.enum([
    'PERMIT',
    'PTO',
    'INSPECTION',
    'CERTIFICATE_OF_OCCUPANCY',
    'UTILITY_INTERCONNECT',
    'FINAL_ACCEPTANCE',
    'OTHER',
  ]),
  name: z.string().trim().min(1, 'Name is required').max(200, 'Name is too long'),
});

export const POST = apiHandler(bodySchema, async (body, ctx) => {
  const guard = await requirePermission(ctx, 'proj_gates', 'create');
  if (!guard.ok) return guard.response;

  const { data, error } = await ctx.supabase
    .schema('proj')
    .from('external_gates')
    .insert({
      job_id: body.job_id,
      gate_type: body.gate_type,
      name: body.name,
    })
    .select('id, gate_type, name, status')
    .single();

  if (error) {
    return NextResponse.json({ error: error.message, code: 'DB_ERROR' }, { status: 400 });
  }

  return NextResponse.json({ gate: data }, { status: 201 });
});
