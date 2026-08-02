export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { loadReport, recomputeReport } from '@/lib/expenses/expense-reports';

const schema = z.object({
  expense_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  merchant: z.string().max(200).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  account_id: z.string().uuid().nullable().optional(),
  department_id: z.string().uuid().nullable().optional(),
  class_id: z.string().uuid().nullable().optional(),
  location_id: z.string().uuid().nullable().optional(),
  amount_cents: z.number().int().nonnegative(),
  payment_source: z.enum(['OUT_OF_POCKET', 'CORPORATE_CARD']).optional(),
  has_receipt: z.boolean().optional(),
  billable: z.boolean().optional(),
  job_id: z.string().uuid().nullable().optional(),
});

/** POST /api/expenses/[id]/lines — add a manual line to a DRAFT/REJECTED report. */
export async function POST(request: Request, { params }: { params: { id: string } }) {
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
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.issues }, { status: 422 });

  let report, lines;
  try {
    ({ report, lines } = await loadReport(supabase, orgId, params.id));
  } catch {
    return NextResponse.json({ error: 'Expense report not found' }, { status: 404 });
  }
  if (report.status !== 'DRAFT' && report.status !== 'REJECTED') {
    return NextResponse.json({ error: 'Lines can only be edited on a draft report' }, { status: 409 });
  }

  const nextLineNumber = lines.reduce((m, l) => Math.max(m, l.line_number), 0) + 1;
  const b = parsed.data;

  const { data: inserted, error } = await supabase
    .from('expense_report_lines')
    .insert({
      org_id: orgId,
      report_id: params.id,
      line_number: nextLineNumber,
      expense_date: b.expense_date,
      merchant: b.merchant ?? null,
      description: b.description ?? null,
      account_id: b.account_id ?? null,
      department_id: b.department_id ?? null,
      class_id: b.class_id ?? null,
      location_id: b.location_id ?? report.location_id ?? null,
      amount_cents: b.amount_cents,
      payment_source: b.payment_source ?? 'OUT_OF_POCKET',
      has_receipt: b.has_receipt ?? false,
      billable: b.billable ?? false,
      job_id: b.job_id ?? null,
    })
    .select('id')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await recomputeReport(supabase, orgId, params.id);
  return NextResponse.json({ line_id: (inserted as { id: string }).id }, { status: 201 });
}
