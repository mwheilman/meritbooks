export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { voidJournalEntry } from '@/lib/services/gl-posting';
import { recordInvoiceEvent } from '@/lib/invoices/invoice-events';
import { assertInvoiceVoidable } from '@/lib/invoices/void-invoice';

/**
 * POST /api/invoices/[id]/void — void an issued-in-error invoice.
 *
 * Allowed ONLY when the invoice has taken no payment (see assertInvoiceVoidable):
 * a paid / partially-paid invoice is refused (409 CANNOT_VOID_PAID) and must be
 * corrected with a credit memo so the customer's copy and the GL agree. A
 * written-off invoice is refused. An already-voided invoice is an idempotent
 * no-op.
 *
 * If the invoice was POSTED to the GL (DR AR / CR revenue-or-2410, plus any tax /
 * retainage lines), voiding REVERSES that issuance entry via voidJournalEntry —
 * which flips the entry to VOIDED so its lines drop out of every balance view,
 * netting the issuance to zero (the same reversal the override-edit path uses).
 * The invoice number is retained for audit — never reused or deleted.
 *
 * Requires invoices:approve. GL author columns stay null (canon §2); human
 * attribution lands in invoice_events + audit_log.
 */
const bodySchema = z.object({ reason: z.string().min(1).max(500).optional() });

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;
  const orgId = authResult.orgId ?? '';
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'invoices', 'approve');
  if (!guard.ok) return guard.response;

  // Reason is optional but strongly encouraged; the drawer prompts for one.
  let reason = 'Voided by user';
  try {
    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (parsed.success && parsed.data.reason) reason = parsed.data.reason.trim();
  } catch {
    /* empty body is fine */
  }

  const supabase = createAdminSupabase();

  const { data: inv, error } = await supabase
    .from('invoices')
    .select('id, status, gl_entry_id, amount_paid_cents, invoice_number')
    .eq('org_id', orgId)
    .eq('id', params.id)
    .single();
  if (error || !inv) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });

  const voidable = assertInvoiceVoidable({
    status: inv.status as string,
    amountPaidCents: Number(inv.amount_paid_cents ?? 0),
  });
  if (!voidable.ok) {
    if (voidable.idempotent) {
      return NextResponse.json({ ok: true, already_voided: true, status: 'VOIDED' });
    }
    return NextResponse.json(
      { error: voidable.message, code: voidable.code },
      { status: voidable.httpStatus },
    );
  }

  // Reverse the issuance journal entry, if this invoice was posted. A hard-closed
  // period refuses in-place void (voidJournalEntry) — surface that clearly rather
  // than leaving a half-voided invoice with a live GL entry.
  if (inv.gl_entry_id) {
    const rev = await voidJournalEntry(
      supabase,
      orgId,
      inv.gl_entry_id as string,
      userId,
      `Invoice ${inv.invoice_number} voided: ${reason}`,
    );
    if (!rev.success) {
      return NextResponse.json(
        { error: `Could not reverse the invoice's GL entry: ${rev.error}`, code: 'GL_REVERSE_FAILED' },
        { status: 409 },
      );
    }
  }

  // Flip status → VOIDED. Guard the update so a race can only win once.
  const { error: upErr } = await supabase
    .from('invoices')
    .update({ status: 'VOIDED', updated_at: new Date().toISOString() })
    .eq('id', inv.id)
    .eq('org_id', orgId)
    .neq('status', 'VOIDED');
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  await recordInvoiceEvent(supabase, {
    orgId,
    invoiceId: inv.id,
    type: 'VOIDED',
    actor: userId,
    meta: { reason, gl_entry_id: inv.gl_entry_id, reversed: !!inv.gl_entry_id },
  });

  // Audit trail (SoD-sensitive money action): who voided, and why.
  await supabase.from('audit_log').insert({
    org_id: orgId,
    table_name: 'invoices',
    record_id: inv.id,
    action: 'UPDATE',
    field_name: 'status',
    old_value: inv.status as string,
    new_value: 'VOIDED',
    user_id: userId,
  });

  return NextResponse.json({ ok: true, status: 'VOIDED', reversed: !!inv.gl_entry_id });
}
