export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { logHumanAction } from '@/lib/trust/action-log';
import {
  approve,
  SeparationOfDutiesError,
  NotAuthorizedToApproveError,
} from '@/lib/money/approvals';

/**
 * POST /api/checks/[id]/approve — human approval step for a queued disbursement.
 *
 * SAFETY: this only transitions PENDING_APPROVAL -> APPROVED via the approvals
 * service. It NEVER releases, settles, or disburses money, and never posts to the
 * GL. Separation of duties (approver != preparer) is enforced inside the service
 * and by a DB CHECK; we surface that as a 400 rather than reimplementing it.
 */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  try {
    const result = await approve(supabase, orgId, params.id, userId);
    await logHumanAction(supabase, userId, orgId, {
      action: 'checks.approve',
      subjectTable: 'approvals',
      subjectId: params.id,
      summary: `Approved disbursement for bill ${result.subjectId} (${result.amountCents ?? 0} cents)`,
      metadata: { approvalId: params.id, billId: result.subjectId, amountCents: result.amountCents },
    });
    return NextResponse.json({ ok: true, status: result.status });
  } catch (e) {
    if (e instanceof SeparationOfDutiesError) {
      return NextResponse.json({ error: e.message, code: 'SEPARATION_OF_DUTIES' }, { status: 400 });
    }
    if (e instanceof NotAuthorizedToApproveError) {
      return NextResponse.json({ error: e.message, code: 'NOT_AUTHORIZED' }, { status: 403 });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Approval failed' },
      { status: 400 },
    );
  }
}
