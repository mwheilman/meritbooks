export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { recomputeReport } from '@/lib/expenses/expense-reports';

const patchSchema = z.object({
  expense_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  merchant: z.string().max(200).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  account_id: z.string().uuid().nullable().optional(),
  department_id: z.string().uuid().nullable().optional(),
  class_id: z.string().uuid().nullable().optional(),
  location_id: z.string().uuid().nullable().optional(),
  amount_cents: z.number().int().nonnegative().optional(),
  payment_source: z.enum(['OUT_OF_POCKET', 'CORPORATE_CARD']).optional(),
  has_receipt: z.boolean().optional(),
  billable: z.boolean().optional(),
  job_id: z.string().uuid().nullable().optional(),
});

/** Guard: the line's report must be editable (DRAFT/REJECTED). Returns report id. */
async function editableReportId(
  supabase: SupabaseClient,
  orgId: string,
  lineId: string,
): Promise<{ ok: true; reportId: string } | { ok: false; status: number; error: string }> {
  const { data: line } = await supabase
    .from('expense_report_lines')
    .select('report_id')
    .eq('org_id', orgId)
    .eq('id', lineId)
    .maybeSingle();
  if (!line) return { ok: false, status: 404, error: 'Line not found' };
  const reportId = (line as { report_id: string }).report_id;
  const { data: report } = await supabase
    .from('expense_reports')
    .select('status')
    .eq('org_id', orgId)
    .eq('id', reportId)
    .maybeSingle();
  const status = (report as { status: string } | null)?.status;
  if (status !== 'DRAFT' && status !== 'REJECTED') {
    return { ok: false, status: 409, error: 'Lines can only be edited on a draft report' };
  }
  return { ok: true, reportId };
}

export async function PATCH(request: Request, { params }: { params: { lineId: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'receipts', 'create');
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.issues }, { status: 422 });

  const editable = await editableReportId(supabase, orgId, params.lineId);
  if (!editable.ok) return NextResponse.json({ error: editable.error }, { status: editable.status });

  const { error } = await supabase
    .from('expense_report_lines')
    .update({ ...parsed.data })
    .eq('id', params.lineId)
    .eq('org_id', orgId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await recomputeReport(supabase, orgId, editable.reportId);
  return NextResponse.json({ updated: true });
}

export async function DELETE(_req: Request, { params }: { params: { lineId: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'receipts', 'create');
  if (!guard.ok) return guard.response;

  const editable = await editableReportId(supabase, orgId, params.lineId);
  if (!editable.ok) return NextResponse.json({ error: editable.error }, { status: editable.status });

  const { error } = await supabase.from('expense_report_lines').delete().eq('id', params.lineId).eq('org_id', orgId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await recomputeReport(supabase, orgId, editable.reportId);
  return NextResponse.json({ deleted: true });
}
