export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { rejectReport } from '@/lib/expenses/expense-reports';
import { logAction } from '@/lib/trust/action-log';

const schema = z.object({ reason: z.string().min(1).max(1000) });

/** POST /api/expenses/[id]/reject — send a SUBMITTED report back with a reason. */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'receipts', 'approve');
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: 'A reject reason is required' }, { status: 422 });

  try {
    const res = await rejectReport(supabase, orgId, params.id, userId, parsed.data.reason);
    await logAction(supabase, {
      orgId,
      actorType: 'HUMAN',
      actorUserId: null,
      action: 'expenses.reject',
      subjectTable: 'expense_reports',
      subjectId: params.id,
      summary: 'Expense report rejected',
      metadata: { rejected_by_clerk_user: userId, reason: parsed.data.reason },
    });
    return NextResponse.json(res);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to reject' }, { status: 400 });
  }
}
