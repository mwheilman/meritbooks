export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { cancelTestPayment, refundTestPayment, TestPaymentError } from '@/lib/money/test-payment';
import { testPaymentCloseBody } from '@/lib/validations/payments';

/**
 * POST /api/payments/test-payment/close  { run_id, action: 'cancel' | 'refund', confirm: true }
 *
 * cancel — the $1 test was never paid: void its invoice (issuance reversed).
 * refund — the $1 test was paid: Stripe refunds it (transfer reversed, platform fee
 *          returned) and its issuance + collection entries are voided, so the company's
 *          books net to zero. Only runs created by the test helper can be refunded here.
 * Requires settings_system:edit (who may run the test) — a refund also returns money, so
 * it additionally needs the AR write-off/refund gate the rest of the app uses for money
 * leaving (invoices:approve, the void gate).
 */
export const POST = apiHandler(testPaymentCloseBody, async (b, ctx) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  const guard = await requirePermission(ctx.userId, 'settings_system', 'edit');
  if (!guard.ok) return guard.response;
  const voidGate = await requirePermission(ctx.userId, 'invoices', 'approve');
  if (!voidGate.ok) return voidGate.response;

  // The run must be visible to the caller (RLS: tenant + client scope) before the service role acts on it.
  const { data: visible } = await ctx.supabase.from('payment_test_runs').select('id').eq('org_id', guard.orgId).eq('id', b.run_id).maybeSingle();
  if (!visible) return NextResponse.json({ error: 'That test payment was not found.' }, { status: 404 });

  try {
    const admin = createAdminSupabase();
    const run = b.action === 'cancel'
      ? await cancelTestPayment(admin, { orgId: guard.orgId, runId: b.run_id, userId: ctx.userId })
      : await refundTestPayment(admin, { orgId: guard.orgId, runId: b.run_id, userId: ctx.userId });
    return NextResponse.json({ ok: true, run });
  } catch (e) {
    if (e instanceof TestPaymentError) return NextResponse.json({ error: e.message, code: 'TEST_PAYMENT' }, { status: e.status });
    throw e;
  }
});
