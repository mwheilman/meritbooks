export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { requirePermission } from '@/lib/rbac/require-permission';
import { receiptApproveBody } from '@/lib/validations/receipts';

/**
 * POST /api/receipts/approve — mark receipts REVIEWED (status APPROVED), one or many
 * (batch approve, audit RC-11). receipts:approve.
 *
 * This posts NOTHING to the GL, by design: a card charge books DR expense / CR Credit Card
 * Payable through the card feed, and the receipt is its evidence (canon §3: never
 * re-expense a settlement). Out-of-pocket spend is reimbursed through an expense report.
 * Only receipts the caller can see (RLS read first) are touched; posted / already
 * approved ones are skipped.
 */
export const POST = apiHandler(receiptApproveBody, async (b, { userId, orgId, supabase }) => {
  const guard = await requirePermission(userId, 'receipts', 'approve', { route: '/api/receipts/approve' });
  if (!guard.ok) return guard.response;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { data: visible, error } = await supabase.from('receipts').select('id, status').eq('org_id', orgId).in('id', b.receipt_ids);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const ids = ((visible ?? []) as Array<{ id: string; status: string }>).filter((r) => r.status === 'PENDING' || r.status === 'CATEGORIZED' || r.status === 'FLAGGED').map((r) => r.id);
  if (ids.length === 0) return NextResponse.json({ approved: 0, skipped: b.receipt_ids.length, message: 'Nothing to approve.' });
  const now = new Date().toISOString();
  const { error: upErr } = await serviceWriter()
    .from('receipts')
    .update({ status: 'APPROVED', approved_at: now, updated_at: now })
    .eq('org_id', orgId)
    .in('id', ids);
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
  await serviceWriter()
    .from('audit_log')
    .insert(ids.map((id) => ({ org_id: orgId, table_name: 'receipts', record_id: id, action: 'UPDATE', field_name: 'status', old_value: null, new_value: 'APPROVED', user_id: userId })));
  return NextResponse.json({ approved: ids.length, skipped: b.receipt_ids.length - ids.length, message: `${ids.length} receipt${ids.length === 1 ? '' : 's'} reviewed.` });
});
