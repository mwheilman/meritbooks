export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';

/**
 * DELETE /api/prepaid/[id] — CANCEL a prepaid schedule (soft: status = CANCELLED).
 *
 * Cancelling stops future amortization; it never deletes or reverses already-posted
 * periods (those are real GL entries). Gated on `journal_entries:create`. RLS scopes
 * the update to the caller's org.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;

  const guard = await requirePermission(ctx.userId, 'journal_entries', 'create');
  if (!guard.ok) return guard.response;

  const { data, error } = await ctx.supabase
    .from('posting_schedules')
    .update({ status: 'CANCELLED', updated_at: new Date().toISOString() })
    .eq('id', params.id)
    .eq('schedule_type', 'PREPAID_AMORTIZATION')
    .neq('status', 'COMPLETED')
    .select('id')
    .maybeSingle();

  if (error) {
    console.error('[prepaid] cancel failed:', error.message);
    return NextResponse.json({ error: 'Failed to cancel schedule', code: 'CANCEL_FAILED' }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'Schedule not found or already completed', code: 'NOT_FOUND' }, { status: 404 });
  }
  return NextResponse.json({ id: (data as { id: string }).id, status: 'CANCELLED' });
}
