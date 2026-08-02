export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { reimburseReport } from '@/lib/expenses/expense-reports';
import { logAction } from '@/lib/trust/action-log';

/**
 * POST /api/expenses/[id]/reimburse — post the out-of-pocket reimbursement
 * (DR expense / CR AP) through the existing posting engine and flip to REIMBURSED.
 * Corporate-card lines are excluded (booked via the card feed).
 *
 * This is a money-movement step, so it is gated on `payments:run` (the closest
 * existing money grant; a dedicated `expenses` permission is REPORTED). The
 * reimbursement itself is idempotent — a report already carrying a GL entry is
 * not re-posted (DB UNIQUE index on gl_entry_id is the guarantor).
 */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'payments', 'run');
  if (!guard.ok) return guard.response;

  try {
    const res = await reimburseReport(supabase, orgId, params.id, userId);
    await logAction(supabase, {
      orgId,
      actorType: 'HUMAN',
      actorUserId: null,
      action: 'expenses.reimburse',
      subjectTable: 'expense_reports',
      subjectId: params.id,
      summary: `Expense report reimbursed — $${(res.reimbursed_cents / 100).toFixed(2)} to AP`,
      metadata: { reimbursed_by_clerk_user: userId, gl_entry_id: res.gl_entry_id, reimbursed_cents: res.reimbursed_cents },
    });
    return NextResponse.json(res);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to reimburse' }, { status: 400 });
  }
}
