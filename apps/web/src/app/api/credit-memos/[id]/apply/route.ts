export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import {
  computeCreditApplication,
  nextInvoiceStateAfterCredit,
  nextCreditMemoStateAfterApply,
} from '@/lib/invoices/credit-memo-posting';
import { recordInvoiceEvent } from '@/lib/invoices/invoice-events';

/**
 * POST /api/credit-memos/[id]/apply — apply a POSTED credit to an open invoice.
 *
 * This posts NO new GL: posting the memo already credited AR control. Applying
 * is a sub-ledger reallocation that lowers the invoice's open balance so the AR
 * sub-ledger still ties to the AR control account. It advances the invoice's
 * amount_paid_cents (the only lever on the generated balance_cents column) and
 * the memo's applied_amount_cents. The computeCreditApplication guard makes it
 * impossible to over-apply either side. Requires invoices:approve.
 *
 * Body: { invoice_id?, amount_cents? }. invoice_id defaults to the memo's linked
 * invoice; amount_cents defaults to the largest safe application.
 */
const applySchema = z.object({
  invoice_id: z.string().uuid().optional(),
  amount_cents: z.number().int().positive().optional(),
});

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;
  const orgId = authResult.orgId ?? '';
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'invoices', 'approve');
  if (!guard.ok) return guard.response;

  const parsed = applySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.issues }, { status: 422 });
  }
  const body = parsed.data;
  const supabase = createAdminSupabase();

  const { data: memo, error: memoErr } = await supabase
    .from('credit_memos')
    .select('id, status, total_cents, applied_amount_cents, invoice_id, customer_id, credit_number')
    .eq('org_id', orgId).eq('id', params.id).single();
  if (memoErr || !memo) return NextResponse.json({ error: 'Credit memo not found' }, { status: 404 });

  // Only a POSTED credit carries a GL-backed balance to apply. (APPLIED means
  // fully consumed; DRAFT has not posted; VOIDED is dead.)
  if (memo.status !== 'POSTED') {
    return NextResponse.json(
      { error: `Only a POSTED credit memo can be applied (status is ${memo.status})`, code: 'NOT_APPLICABLE' },
      { status: 409 },
    );
  }

  const targetInvoiceId = body.invoice_id ?? (memo.invoice_id as string | null);
  if (!targetInvoiceId) {
    return NextResponse.json({ error: 'No target invoice — pass invoice_id or link the memo to an invoice', code: 'NO_TARGET' }, { status: 422 });
  }

  const { data: inv, error: invErr } = await supabase
    .from('invoices')
    .select('id, customer_id, amount_paid_cents, total_cents, balance_cents, status')
    .eq('org_id', orgId).eq('id', targetInvoiceId).single();
  if (invErr || !inv) return NextResponse.json({ error: 'Target invoice not found' }, { status: 404 });
  if ((inv.customer_id as string) !== (memo.customer_id as string)) {
    return NextResponse.json({ error: 'Credit memo and invoice belong to different customers', code: 'CUSTOMER_MISMATCH' }, { status: 422 });
  }
  if (inv.status === 'VOIDED' || inv.status === 'WRITTEN_OFF') {
    return NextResponse.json({ error: `Cannot apply a credit to a ${inv.status} invoice` }, { status: 409 });
  }

  const creditTotalCents = Number(memo.total_cents ?? 0);
  const creditAppliedCents = Number(memo.applied_amount_cents ?? 0);
  const invoiceBalanceCents = Number(inv.balance_cents ?? 0);

  const { applyCents } = computeCreditApplication({
    creditTotalCents,
    creditAppliedCents,
    invoiceBalanceCents,
    requestedCents: body.amount_cents ?? null,
  });

  if (applyCents <= 0) {
    return NextResponse.json(
      { error: 'Nothing to apply — the credit is fully applied or the invoice has no open balance', code: 'NOTHING_TO_APPLY' },
      { status: 409 },
    );
  }

  // Advance the invoice. amount_paid_cents is an incrementing balance (also
  // written by payments/import) — never recompute it. balance_cents is generated.
  const inv2 = nextInvoiceStateAfterCredit({
    prevPaidCents: Number(inv.amount_paid_cents ?? 0),
    totalCents: Number(inv.total_cents ?? 0),
    applyCents,
  });
  const { error: invUpErr } = await supabase
    .from('invoices')
    .update({ amount_paid_cents: inv2.newPaidCents, status: inv2.status, updated_at: new Date().toISOString() })
    .eq('id', inv.id).eq('org_id', orgId)
    // Optimistic guard: only advance from the balance we computed against, so a
    // concurrent payment/credit can't double-decrement.
    .eq('amount_paid_cents', Number(inv.amount_paid_cents ?? 0));
  if (invUpErr) return NextResponse.json({ error: invUpErr.message }, { status: 500 });

  // Advance the memo. Guard against a racing apply by pinning applied_amount.
  const memo2 = nextCreditMemoStateAfterApply({ prevAppliedCents: creditAppliedCents, totalCents: creditTotalCents, applyCents });
  const { data: memoUp, error: memoUpErr } = await supabase
    .from('credit_memos')
    .update({ applied_amount_cents: memo2.newAppliedCents, status: memo2.status, updated_at: new Date().toISOString() })
    .eq('id', memo.id).eq('org_id', orgId)
    .eq('applied_amount_cents', creditAppliedCents)
    .select('id');
  if (memoUpErr) return NextResponse.json({ error: memoUpErr.message }, { status: 500 });
  if (!memoUp || memoUp.length === 0) {
    // A concurrent apply already moved this memo — surface a conflict rather than
    // leaving the invoice advanced twice.
    return NextResponse.json({ error: 'Credit memo was modified concurrently; retry', code: 'CONCURRENT_MODIFICATION' }, { status: 409 });
  }

  await recordInvoiceEvent(supabase, {
    orgId, invoiceId: inv.id as string, type: 'PAYMENT_APPLIED', actor: userId,
    meta: { source: 'credit_memo', credit_memo_id: memo.id, credit_number: memo.credit_number, applied_cents: applyCents },
  });
  if (inv2.status === 'PAID') {
    await recordInvoiceEvent(supabase, { orgId, invoiceId: inv.id as string, type: 'MARKED_PAID', actor: 'system', meta: { via: 'credit_memo', credit_memo_id: memo.id } });
  }

  return NextResponse.json({
    ok: true,
    applied_cents: applyCents,
    invoice: { id: inv.id, status: inv2.status, amount_paid_cents: inv2.newPaidCents },
    credit_memo: { id: memo.id, status: memo2.status, applied_amount_cents: memo2.newAppliedCents },
  });
}
