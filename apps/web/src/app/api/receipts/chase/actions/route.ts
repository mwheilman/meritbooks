export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { consumeSendQuota } from '@/lib/email/send-quota';
import { defaultChannels, outboundAppUrl } from '@/lib/notify/channels';
import { requirePermission } from '@/lib/rbac/require-permission';
import { ChaseActionError, markNotRequired, reassignCharge, remindNow, reopenCharge } from '@/lib/receipts/bookkeeper';
import { chaseActionBody } from '@/lib/validations/receipts';

/**
 * POST /api/receipts/chase/actions — Remind now · Not required (reason) · Reopen · Reassign.
 *
 * receipts:edit. The charge state is READ through the caller's RLS client first (proves
 * org + client scope) before the service role writes (181 tables are member-SELECT-only).
 * "Remind now" is metered against the outbound email quota like any member-triggered send.
 */
export const POST = apiHandler(chaseActionBody, async (b, { userId, orgId, supabase }) => {
  const guard = await requirePermission(userId, 'receipts', 'edit', { route: '/api/receipts/chase/actions' });
  if (!guard.ok) return guard.response;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { data: visible } = await supabase
    .from('receipt_charge_states')
    .select('id, status')
    .eq('org_id', orgId)
    .eq('bank_transaction_id', b.transaction_id)
    .maybeSingle();
  if (!visible) return NextResponse.json({ error: 'That charge was not found.' }, { status: 404 });

  const db = serviceWriter();
  const now = new Date();
  try {
    switch (b.action) {
      case 'remind': {
        const q = await consumeSendQuota(orgId, userId, 1, 'request');
        if (!q.ok) return NextResponse.json({ error: q.error, code: q.code }, { status: q.status, headers: { 'Retry-After': String(q.retryAfterSec) } });
        const message = await remindNow({ db, channels: defaultChannels(), now: () => new Date(), appUrl: outboundAppUrl() }, orgId, b.transaction_id, userId);
        return NextResponse.json({ ok: true, message });
      }
      case 'not_required':
        await markNotRequired(db, orgId, b.transaction_id, userId, b.reason, now);
        return NextResponse.json({ ok: true, message: 'Marked not required. No more reminders for this charge.' });
      case 'reopen':
        await reopenCharge(db, orgId, b.transaction_id, userId, now);
        return NextResponse.json({ ok: true, message: 'Reopened — the cardholder will be asked again.' });
      case 'reassign': {
        const { data: a } = await supabase.from('card_assignments').select('id').eq('org_id', orgId).eq('id', b.assignment_id).maybeSingle();
        if (!a) return NextResponse.json({ error: 'That cardholder was not found.' }, { status: 404 });
        await reassignCharge(db, orgId, b.transaction_id, b.assignment_id, userId, now);
        return NextResponse.json({ ok: true, message: 'Reassigned. The new cardholder is being asked.' });
      }
    }
  } catch (e) {
    if (e instanceof ChaseActionError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
});
