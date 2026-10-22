export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { isWriteScopeError, loadWritableRow, serviceWriter } from '@/lib/db/scoped-writer';

/**
 * DELETE /api/prepaid/[id] — CANCEL a prepaid schedule (soft: status = CANCELLED).
 *
 * Cancelling stops future amortization; it never deletes or reverses already-posted
 * periods (those are real GL entries). Gated on `journal_entries:create`. The
 * schedule is loaded org-pinned with its client asserted in the caller's scope, then
 * updated through the service role (posting_schedules is SELECT-only for members, 172).
 */
export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;

  const guard = await requirePermission(ctx.userId, 'journal_entries', 'create');
  if (!guard.ok) return guard.response;
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  try {
    const row = await loadWritableRow(ctx.supabase, ctx.orgId, { table: 'posting_schedules', id: params.id });
    if (!row) {
      return NextResponse.json({ error: 'Schedule not found or already completed', code: 'NOT_FOUND' }, { status: 404 });
    }
  } catch (e) {
    if (isWriteScopeError(e)) return NextResponse.json({ error: e.message, code: 'FORBIDDEN' }, { status: 403 });
    console.error('[prepaid] cancel lookup failed:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Failed to cancel schedule', code: 'CANCEL_FAILED' }, { status: 500 });
  }

  // posting_schedules is SELECT-only for members (migration 172): service-role update after
  // the permission + scope checks, org pinned.
  const { data, error } = await serviceWriter()
    .from('posting_schedules')
    .update({ status: 'CANCELLED', updated_at: new Date().toISOString() })
    .eq('id', params.id)
    .eq('org_id', ctx.orgId)
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
