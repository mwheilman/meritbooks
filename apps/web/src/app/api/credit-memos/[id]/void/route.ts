export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';

/**
 * POST /api/credit-memos/[id]/void — void a credit memo BEFORE it posts.
 *
 * A DRAFT credit has no GL entry and no application, so voiding is a clean status
 * flip to VOIDED (the number is retained for audit; never reused/deleted). A
 * POSTED credit has relieved AR and possibly been applied — it must be reversed
 * through the GL, not voided in place, so this route refuses it and tells the
 * caller to reverse instead. Requires invoices:approve.
 */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;
  const orgId = authResult.orgId ?? '';
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'invoices', 'approve');
  if (!guard.ok) return guard.response;

  const supabase = createAdminSupabase();

  const { data: memo, error } = await supabase
    .from('credit_memos')
    .select('id, status, gl_entry_id')
    .eq('org_id', orgId).eq('id', params.id).single();
  if (error || !memo) return NextResponse.json({ error: 'Credit memo not found' }, { status: 404 });

  if (memo.status === 'VOIDED') {
    return NextResponse.json({ ok: true, already_voided: true });
  }
  if (memo.gl_entry_id || memo.status !== 'DRAFT') {
    return NextResponse.json(
      {
        error: 'This credit memo is posted. Reverse it through the GL instead of voiding in place.',
        code: 'CANNOT_VOID_POSTED',
      },
      { status: 409 },
    );
  }

  const { error: upErr } = await supabase
    .from('credit_memos')
    .update({ status: 'VOIDED', updated_at: new Date().toISOString() })
    .eq('id', memo.id).eq('org_id', orgId).eq('status', 'DRAFT');
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, status: 'VOIDED' });
}
