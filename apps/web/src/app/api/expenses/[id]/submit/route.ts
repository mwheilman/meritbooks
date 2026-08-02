export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { submitReport } from '@/lib/expenses/expense-reports';
import { logAction } from '@/lib/trust/action-log';

/** POST /api/expenses/[id]/submit — submit a DRAFT report for approval. */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'receipts', 'create');
  if (!guard.ok) return guard.response;

  try {
    const res = await submitReport(supabase, orgId, params.id, userId);
    await logAction(supabase, {
      orgId,
      actorType: 'HUMAN',
      actorUserId: null,
      action: 'expenses.submit',
      subjectTable: 'expense_reports',
      subjectId: params.id,
      summary: `Expense report submitted (${res.flaggedCount} policy flag(s))`,
      metadata: { submitted_by_clerk_user: userId, flagged: res.flaggedCount },
    });
    return NextResponse.json(res);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to submit' }, { status: 400 });
  }
}
