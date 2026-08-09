export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { cancelInsuranceSchedule, InsuranceAmortizationError } from '@/lib/insurance/amortize';

/**
 * DELETE /api/insurance/schedules/[id] — cancel an amortization schedule. Future
 * amortization stops; posted periods (and their GL entries) are untouched. Gated on
 * `journal_entries:create`. RLS scopes the update to the org. Dynamic-param routes
 * can't use the apiHandler wrapper, so auth/permission are enforced by hand.
 */
export async function DELETE(_request: Request, { params }: { params: { id: string } }): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;

  const guard = await requirePermission(ctx.userId, 'journal_entries', 'create');
  if (!guard.ok) return guard.response;

  try {
    await cancelInsuranceSchedule(ctx.supabase, params.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof InsuranceAmortizationError ? e.message : 'Failed to cancel schedule';
    return NextResponse.json({ error: msg, code: 'CANCEL_FAILED' }, { status: 500 });
  }
}
