import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';

// POST /api/schedule/work-orders — create a dispatch-board work order.
// RLS-scoped: ctx.supabase runs AS THE USER, so org_id auto-fills from
// get_org_id() (never set it here) and the row lands in the caller's org only.

const WORK_ORDER_STATUSES = [
  'DRAFT',
  'SCHEDULED',
  'DISPATCHED',
  'IN_PROGRESS',
  'ON_HOLD',
  'COMPLETED',
  'CANCELED',
] as const;

const createSchema = z.object({
  job_id: z.string().uuid(),
  title: z.string().trim().min(1, 'Title is required').max(200),
  status: z.enum(WORK_ORDER_STATUSES).optional(),
  assigned_employee_id: z.string().uuid().nullish(),
  required_capability: z.string().trim().min(1).max(120).nullish(),
  zone: z.string().trim().min(1).max(120).nullish(),
  priority: z.coerce.number().int().min(0).max(3).optional(),
  estimated_minutes: z.coerce.number().int().positive().max(100_000).nullish(),
  cost_code_id: z.string().uuid().nullish(),
});

export const POST = apiHandler(createSchema, async (body, { supabase, userId }) => {
  const guard = await requirePermission({ userId, supabase }, 'proj_schedule', 'create');
  if (!guard.ok) return guard.response;

  const row: {
    job_id: string;
    title: string;
    status?: string;
    assigned_employee_id?: string;
    required_capability?: string;
    zone?: string;
    priority?: number;
    estimated_minutes?: number;
    cost_code_id?: string;
    completed_at?: string;
  } = { job_id: body.job_id, title: body.title };

  if (body.status) row.status = body.status;
  if (body.assigned_employee_id) row.assigned_employee_id = body.assigned_employee_id;
  if (body.required_capability) row.required_capability = body.required_capability;
  if (body.zone) row.zone = body.zone;
  if (typeof body.priority === 'number') row.priority = body.priority;
  if (typeof body.estimated_minutes === 'number') row.estimated_minutes = body.estimated_minutes;
  if (body.cost_code_id) row.cost_code_id = body.cost_code_id;
  if (row.status === 'COMPLETED') row.completed_at = new Date().toISOString();

  const { data, error } = await supabase
    .schema('proj')
    .from('work_orders')
    .insert(row)
    .select('id, status')
    .single();

  if (error) {
    return NextResponse.json({ error: error.message, code: 'INSERT_FAILED' }, { status: 400 });
  }
  return NextResponse.json({ workOrder: data }, { status: 201 });
});
