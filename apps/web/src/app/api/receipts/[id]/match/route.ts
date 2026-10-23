export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { requirePermission } from '@/lib/rbac/require-permission';
import { autoMatchReceipt, linkReceiptToCharge, MatchError, unlinkReceipt } from '@/lib/receipts/match';
import { loadReceiptPolicyContext, mergeReceiptPolicy } from '@/lib/receipts/policy';
import { receiptMatchBody } from '@/lib/validations/receipts';

/**
 * POST /api/receipts/[id]/match — confirm the suggested charge · link to a charge the
 * person picked · unmatch · re-run matching · mark the receipt not needed for any charge.
 *
 * receipts:edit. The receipt (and, for `link`, the charge) are READ through the caller's
 * RLS client first — org + client scope — before the service role writes. Linking closes
 * the chase for that charge (its request is fulfilled).
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { orgId, userId, supabase } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const guard = await requirePermission(userId, 'receipts', 'edit', { route: '/api/receipts/[id]/match' });
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = receiptMatchBody.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Validation failed' }, { status: 422 });
  const b = parsed.data;

  const { data: rec } = await supabase
    .from('receipts')
    .select('id, location_id, vendor_name, amount_cents, receipt_date, card_assignment_id, bank_transaction_id, match_candidate_txn_id, match_score')
    .eq('org_id', orgId)
    .eq('id', params.id)
    .maybeSingle();
  if (!rec) return NextResponse.json({ error: 'Receipt not found' }, { status: 404 });
  const r = rec as {
    id: string;
    location_id: string;
    vendor_name: string | null;
    amount_cents: number | null;
    receipt_date: string | null;
    card_assignment_id: string | null;
    bank_transaction_id: string | null;
    match_candidate_txn_id: string | null;
    match_score: number | null;
  };
  const db = serviceWriter();
  const now = new Date();
  try {
    switch (b.action) {
      case 'confirm': {
        if (!r.match_candidate_txn_id) return NextResponse.json({ error: 'There is no suggested charge to confirm.' }, { status: 409 });
        const { chaseCount } = await linkReceiptToCharge(db, orgId, r.id, r.match_candidate_txn_id, { method: 'confirmed', score: r.match_score != null ? Number(r.match_score) : null, actor: userId, now });
        return NextResponse.json({ ok: true, message: chaseCount ? `Matched. The cardholder had been asked ${chaseCount} time${chaseCount === 1 ? '' : 's'}; reminders stopped.` : 'Matched.' });
      }
      case 'link': {
        const { data: t } = await supabase.from('bank_transactions').select('id').eq('org_id', orgId).eq('id', b.transaction_id).maybeSingle();
        if (!t) return NextResponse.json({ error: 'That charge was not found.' }, { status: 404 });
        await linkReceiptToCharge(db, orgId, r.id, b.transaction_id, { method: 'manual', score: null, actor: userId, now });
        return NextResponse.json({ ok: true, message: 'Matched to the charge you picked.' });
      }
      case 'unmatch':
        await unlinkReceipt(db, orgId, r.id, userId, now);
        return NextResponse.json({ ok: true, message: 'Unmatched. The charge needs a receipt again.' });
      case 'rematch': {
        const pctx = await loadReceiptPolicyContext(db, orgId);
        const out = await autoMatchReceipt(db, orgId, r, mergeReceiptPolicy(pctx.rows, r.location_id), now, userId);
        const message = out.kind === 'matched' ? 'Matched automatically.' : out.kind === 'suggested' ? 'Found a likely charge — confirm it.' : 'No charge looks like this receipt yet. It will be checked again as charges arrive.';
        return NextResponse.json({ ok: true, outcome: out.kind, message });
      }
      case 'not_required': {
        if (r.bank_transaction_id) return NextResponse.json({ error: 'Unmatch it first.' }, { status: 409 });
        await db
          .from('receipts')
          .update({ match_status: 'not_required', match_candidate_txn_id: null, updated_at: now.toISOString() })
          .eq('org_id', orgId)
          .eq('id', r.id);
        // The reason is evidence: append-only audit_log (receipts has no reason column).
        await db.from('audit_log').insert({ org_id: orgId, table_name: 'receipts', record_id: r.id, action: 'UPDATE', field_name: 'match_status', old_value: 'unmatched', new_value: `not_required: ${b.reason}`.slice(0, 500), user_id: userId });
        return NextResponse.json({ ok: true, message: 'Kept on file without a charge.' });
      }
    }
  } catch (e) {
    if (e instanceof MatchError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
