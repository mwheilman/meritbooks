export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { bookInternalInvoice, type ChargeMethod } from '@/lib/services/internal-invoices';
import { z } from 'zod';

const actionSchema = z.object({
  action: z.enum(['send', 'approve', 'reject', 'void']),
  reason: z.string().max(500).optional().nullable(),
});

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const supabase = createAdminSupabase();
  const { data, error } = await supabase
    .from('internal_invoices')
    .select(`
      id, invoice_number, invoice_date, memo, status, charge_method, total_cents,
      job_id, booked_gl_entry_id, rejection_reason, location_id,
      provider_department_id, receiver_department_id,
      sent_at, approved_at, rejected_at, booked_at, created_at,
      location:locations!internal_invoices_location_id_fkey(id, name, short_code),
      provider:departments!internal_invoices_provider_department_id_fkey(id, name, code),
      receiver:departments!internal_invoices_receiver_department_id_fkey(id, name, code),
      lines:internal_invoice_lines(id, line_number, description, amount_cents)
    `)
    .eq('id', params.id)
    .single();
  if (error || !data) return NextResponse.json({ error: 'Invoice not found', code: 'NOT_FOUND' }, { status: 404 });
  return NextResponse.json({ data });
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const authResult = await auth().catch(() => ({ userId: null as string | null }));
  const userId = authResult.userId ?? null;
  const supabase = createAdminSupabase();

  let body: z.infer<typeof actionSchema>;
  try {
    const result = actionSchema.safeParse(await request.json());
    if (!result.success) {
      return NextResponse.json({ error: 'Invalid action', code: 'VALIDATION_ERROR' }, { status: 422 });
    }
    body = result.data;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }

  const { data: inv, error: invErr } = await supabase
    .from('internal_invoices')
    .select('id, org_id, location_id, status, charge_method, total_cents, invoice_date, memo, provider_department_id, receiver_department_id')
    .eq('id', params.id)
    .single();
  if (invErr || !inv) return NextResponse.json({ error: 'Invoice not found', code: 'NOT_FOUND' }, { status: 404 });

  const now = new Date().toISOString();
  const status = inv.status as string;

  // ---- SEND: draft -> sent (resolve effective charge method; provider governs) ----
  if (body.action === 'send') {
    if (status !== 'draft') {
      return NextResponse.json({ error: `Only draft invoices can be sent (current: ${status})`, code: 'BAD_STATE' }, { status: 409 });
    }
    if (Number(inv.total_cents) <= 0) {
      return NextResponse.json({ error: 'Cannot send a zero-total invoice', code: 'ZERO_TOTAL' }, { status: 422 });
    }
    // Resolve provider department method; inherit -> company default
    const { data: providerDept } = await supabase
      .from('departments').select('internal_charge_method').eq('id', inv.provider_department_id).single();
    let method = (providerDept?.internal_charge_method as string) ?? 'inherit';
    if (method === 'inherit') {
      const { data: loc } = await supabase
        .from('locations').select('default_internal_charge_method').eq('id', inv.location_id).single();
      method = (loc?.default_internal_charge_method as string) ?? 'revenue';
    }
    const { error } = await supabase
      .from('internal_invoices')
      .update({ status: 'sent', sent_at: now, sent_by: null, charge_method: method })
      .eq('id', inv.id);
    if (error) return NextResponse.json({ error: error.message, code: 'UPDATE_ERROR' }, { status: 500 });
    return NextResponse.json({ success: true, status: 'sent', chargeMethod: method });
  }

  // ---- APPROVE: sent -> booked (post the GL entry) ----
  if (body.action === 'approve') {
    if (status !== 'sent') {
      return NextResponse.json({ error: `Only sent invoices can be approved (current: ${status})`, code: 'BAD_STATE' }, { status: 409 });
    }
    let glEntryId: string;
    try {
      const result = await bookInternalInvoice(supabase, {
        orgId: inv.org_id as string,
        locationId: inv.location_id as string,
        invoiceDate: inv.invoice_date as string,
        totalCents: Number(inv.total_cents),
        providerDepartmentId: inv.provider_department_id as string,
        receiverDepartmentId: inv.receiver_department_id as string,
        chargeMethod: (inv.charge_method as ChargeMethod) === 'cost_transfer' ? 'cost_transfer' : 'revenue',
        memo: (inv.memo as string) ?? null,
        postedBy: null,
      });
      glEntryId = result.glEntryId;
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Booking failed', code: 'BOOKING_ERROR' }, { status: 422 });
    }
    const { error } = await supabase
      .from('internal_invoices')
      .update({ status: 'booked', approved_at: now, approved_by: null, booked_at: now, booked_gl_entry_id: glEntryId })
      .eq('id', inv.id);
    if (error) return NextResponse.json({ error: error.message, code: 'UPDATE_ERROR' }, { status: 500 });
    return NextResponse.json({ success: true, status: 'booked', glEntryId });
  }

  // ---- REJECT: sent -> rejected ----
  if (body.action === 'reject') {
    if (status !== 'sent') {
      return NextResponse.json({ error: `Only sent invoices can be rejected (current: ${status})`, code: 'BAD_STATE' }, { status: 409 });
    }
    const { error } = await supabase
      .from('internal_invoices')
      .update({ status: 'rejected', rejected_at: now, rejected_by: null, rejection_reason: body.reason ?? null })
      .eq('id', inv.id);
    if (error) return NextResponse.json({ error: error.message, code: 'UPDATE_ERROR' }, { status: 500 });
    return NextResponse.json({ success: true, status: 'rejected' });
  }

  // ---- VOID: draft|sent|rejected -> void (booked invoices need a GL reversal, not supported here) ----
  if (body.action === 'void') {
    if (status === 'booked') {
      return NextResponse.json({ error: 'Booked invoices cannot be voided — reverse the GL entry instead', code: 'BOOKED_LOCK' }, { status: 409 });
    }
    if (status === 'void') {
      return NextResponse.json({ error: 'Invoice is already void', code: 'BAD_STATE' }, { status: 409 });
    }
    const { error } = await supabase
      .from('internal_invoices')
      .update({ status: 'void', voided_at: now, voided_by: null })
      .eq('id', inv.id);
    if (error) return NextResponse.json({ error: error.message, code: 'UPDATE_ERROR' }, { status: 500 });
    return NextResponse.json({ success: true, status: 'void' });
  }

  return NextResponse.json({ error: 'Unknown action', code: 'BAD_ACTION' }, { status: 400 });
}
