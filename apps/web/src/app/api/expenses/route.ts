export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { buildReportFromReceipts } from '@/lib/expenses/expense-reports';

/**
 * GET  /api/expenses?scope=mine|queue  — my reports, or the approver queue.
 * POST /api/expenses                    — create a DRAFT report from receipts.
 *
 * RBAC (reported: a dedicated `expenses` permission is the right long-term home;
 * for now we borrow the closest existing internal grants):
 *   list/create → receipts:view / receipts:create.
 */

const listSchema = z.object({ scope: z.enum(['mine', 'queue']).optional() });

export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'receipts', 'view');
  if (!guard.ok) return guard.response;

  const { searchParams } = new URL(request.url);
  const parsed = listSchema.safeParse({ scope: searchParams.get('scope') ?? undefined });
  const scope = parsed.success ? parsed.data.scope ?? 'mine' : 'mine';

  let query = supabase
    .from('expense_reports')
    .select(
      'id, title, status, total_cents, reimbursable_cents, card_cents, policy_flag_count, employee_id, submitted_by, submitted_at, approved_by, created_by, created_at'
    )
    .eq('org_id', orgId);

  if (scope === 'queue') {
    // Approver queue: submitted reports awaiting a decision.
    query = query.eq('status', 'SUBMITTED');
  } else {
    // My reports: created by me (and, transitionally, drafts I own).
    query = query.eq('created_by', userId);
  }

  const { data, error } = await query.order('created_at', { ascending: false }).limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as Array<Record<string, unknown>>;

  // Counts for the header strip.
  const counts = { DRAFT: 0, SUBMITTED: 0, APPROVED: 0, REIMBURSED: 0, REJECTED: 0 } as Record<string, number>;
  for (const r of rows) {
    const s = String(r.status);
    if (s in counts) counts[s] += 1;
  }

  return NextResponse.json({ data: rows, counts, scope });
}

const createSchema = z.object({
  title: z.string().max(200).optional(),
  receipt_ids: z.array(z.string().uuid()).max(200).optional(),
});

export async function POST(request: Request) {
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
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 422 });

  // Resolve the caller's employee id (the person owed the reimbursement).
  let employeeId: string | null = null;
  try {
    const { data: emp } = await supabase
      .schema('core')
      .from('employees')
      .select('id')
      .eq('org_id', orgId)
      .eq('clerk_user_id', userId)
      .eq('is_active', true)
      .maybeSingle();
    employeeId = (emp as { id: string } | null)?.id ?? null;
  } catch {
    /* employee lookup optional */
  }

  try {
    const res = await buildReportFromReceipts(supabase, {
      orgId,
      employeeId,
      createdBy: userId,
      title: parsed.data.title ?? null,
      receiptIds: parsed.data.receipt_ids ?? [],
    });
    return NextResponse.json(res, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to create report' }, { status: 400 });
  }
}
