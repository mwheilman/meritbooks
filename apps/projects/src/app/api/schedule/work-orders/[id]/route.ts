import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';

// PATCH /api/schedule/work-orders/[id] — advance a work order's status and/or
// (re)assign it. RLS-scoped (ctx.supabase AS THE USER): the .eq('id') update
// only touches rows in the caller's org, so a cross-org id resolves to 0 rows.
//
// apiHandler exposes only (body, ctx) — not the route's dynamic segment — so the
// work-order id travels in the validated body (kept in sync with the [id] path
// by the caller). Completing stamps completed_at; leaving COMPLETED clears it.

const WORK_ORDER_STATUSES = [
  'DRAFT',
  'SCHEDULED',
  'DISPATCHED',
  'IN_PROGRESS',
  'ON_HOLD',
  'COMPLETED',
  'CANCELED',
] as const;

const patchSchema = z
  .object({
    id: z.string().uuid(),
    status: z.enum(WORK_ORDER_STATUSES).optional(),
    assigned_employee_id: z.string().uuid().nullable().optional(),
  })
  .refine((b) => b.status !== undefined || b.assigned_employee_id !== undefined, {
    message: 'Provide a status change or an assignment.',
  });

export const PATCH = apiHandler(patchSchema, async (body, { supabase, userId }) => {
  const guard = await requirePermission({ userId, supabase }, 'proj_schedule', 'edit');
  if (!guard.ok) return guard.response;

  const patch: {
    updated_at: string;
    status?: string;
    completed_at?: string | null;
    assigned_employee_id?: string | null;
  } = { updated_at: new Date().toISOString() };

  if (body.status !== undefined) {
    patch.status = body.status;
    patch.completed_at = body.status === 'COMPLETED' ? new Date().toISOString() : null;
  }
  if (body.assigned_employee_id !== undefined) {
    patch.assigned_employee_id = body.assigned_employee_id;
  }

  const { data, error } = await supabase
    .schema('proj')
    .from('work_orders')
    .update(patch)
    .eq('id', body.id)
    .select('id, status, assigned_employee_id, completed_at')
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message, code: 'UPDATE_FAILED' }, { status: 400 });
  }
  if (!data) {
    return NextResponse.json({ error: 'Work order not found', code: 'NOT_FOUND' }, { status: 404 });
  }
  return NextResponse.json({ workOrder: data });
});
