export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { reimburseReport } from '@/lib/expenses/expense-reports';
import { logAction } from '@/lib/trust/action-log';

/**
 * POST /api/expenses/batch — reimburse many APPROVED reports in one action.
 *
 * This is a SURFACE over the existing reimbursement path: it loops the same
 * `reimburseReport()` used by the single-report route, which posts DR expense /
 * CR Accounts Payable through the existing posting engine and flips the report to
 * REIMBURSED. It does NOT re-implement or alter posting — each report is still
 * idempotent (a report already carrying a gl_entry_id is not re-posted; the DB
 * UNIQUE index on gl_entry_id is the guarantor). Failures on individual reports do
 * not abort the batch — each result is reported back so the operator can retry.
 *
 * Money movement ⇒ gated on `payments:run`.
 */
const schema = z.object({
  report_ids: z.array(z.string().uuid()).min(1).max(100),
});

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'payments', 'run');
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Select at least one approved report to reimburse' }, { status: 422 });
  }

  // De-dup so a repeated id can never post twice within one batch.
  const ids = Array.from(new Set(parsed.data.report_ids));

  const results: Array<{
    id: string;
    ok: boolean;
    status?: string;
    gl_entry_id?: string | null;
    reimbursed_cents?: number;
    error?: string;
  }> = [];
  let totalReimbursedCents = 0;
  let successCount = 0;
  let failCount = 0;

  for (const id of ids) {
    try {
      const res = await reimburseReport(supabase, orgId, id, userId);
      totalReimbursedCents += res.reimbursed_cents ?? 0;
      successCount += 1;
      results.push({
        id,
        ok: true,
        status: res.status,
        gl_entry_id: res.gl_entry_id,
        reimbursed_cents: res.reimbursed_cents,
      });
    } catch (e) {
      failCount += 1;
      results.push({ id, ok: false, error: e instanceof Error ? e.message : 'Failed to reimburse' });
    }
  }

  await logAction(supabase, {
    orgId,
    actorType: 'HUMAN',
    actorUserId: null,
    action: 'expenses.reimburse.batch',
    subjectTable: 'expense_reports',
    subjectId: null,
    summary: `Batch reimbursement — ${successCount} report(s), $${(totalReimbursedCents / 100).toFixed(2)} to AP${
      failCount > 0 ? ` (${failCount} failed)` : ''
    }`,
    metadata: {
      reimbursed_by_clerk_user: userId,
      requested: ids.length,
      success_count: successCount,
      fail_count: failCount,
      total_reimbursed_cents: totalReimbursedCents,
      results,
    },
  });

  return NextResponse.json({ results, totalReimbursedCents, successCount, failCount });
}
