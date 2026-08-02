export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { approveReport } from '@/lib/expenses/expense-reports';
import { logAction } from '@/lib/trust/action-log';

/**
 * POST /api/expenses/[id]/approve — approve a SUBMITTED report.
 * Enforces SEGREGATION OF DUTIES (approver ≠ submitter) inside approveReport.
 */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'receipts', 'approve');
  if (!guard.ok) return guard.response;

  try {
    const res = await approveReport(supabase, orgId, params.id, userId);
    await logAction(supabase, {
      orgId,
      actorType: 'HUMAN',
      actorUserId: null,
      action: 'expenses.approve',
      subjectTable: 'expense_reports',
      subjectId: params.id,
      summary: 'Expense report approved',
      metadata: { approved_by_clerk_user: userId },
    });
    return NextResponse.json(res);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed to approve';
    const status = /Segregation of duties/i.test(msg) ? 403 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}
