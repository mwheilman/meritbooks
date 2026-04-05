export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { z } from 'zod';
import { postJournalEntry } from '@/lib/services/gl-posting';

const paymentSchema = z.object({
  customer_id: z.string().uuid(),
  location_id: z.string().uuid(),
  payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount_cents: z.number().int().min(1, 'Amount must be positive'),
  payment_method: z.enum(['CHECK', 'ACH', 'WIRE', 'CREDIT_CARD', 'CASH', 'OTHER']),
  reference_number: z.string().max(100).optional(),
  bank_account_id: z.string().uuid().optional(),
  applications: z.array(z.object({
    invoice_id: z.string().uuid(),
    amount_cents: z.number().int().min(1),
  })).min(1, 'Must apply to at least one invoice'),
});

export async function POST(request: Request) {
  const authResult = await auth().catch(() => ({ userId: null as string | null, orgId: null as string | null }));
  const userId = authResult.userId ?? 'dev-user';
  const orgId = authResult.orgId ?? '';

  try {
    const raw = await request.json();
    const result = paymentSchema.safeParse(raw);

    if (!result.success) {
      const errors: Record<string, string[]> = {};
      for (const issue of result.error.issues) {
        const path = issue.path.join('.') || '_root';
        if (!errors[path]) errors[path] = [];
        errors[path].push(issue.message);
      }
      return NextResponse.json({ error: 'Validation failed', details: errors }, { status: 422 });
    }

    const body = result.data;
    const supabase = createAdminSupabase();

    // Validate: total applications must not exceed payment amount
    const totalApplied = body.applications.reduce((s, a) => s + a.amount_cents, 0);
    if (totalApplied > body.amount_cents) {
      return NextResponse.json({ error: 'Applied amounts exceed payment total' }, { status: 422 });
    }

    // Validate: each application amount doesn't exceed invoice balance
    for (const app of body.applications) {
      const { data: inv } = await supabase
        .from('invoices')
        .select('balance_cents, invoice_number')
        .eq('id', app.invoice_id)
        .single();

      if (!inv) {
        return NextResponse.json({ error: `Invoice ${app.invoice_id} not found` }, { status: 404 });
      }
      if (app.amount_cents > Number(inv.balance_cents)) {
        return NextResponse.json({ error: `Payment of ${app.amount_cents} exceeds balance of ${inv.balance_cents} on invoice ${inv.invoice_number}` }, { status: 422 });
      }
    }

    // Post GL entry: Debit Cash, Credit AR
    const { data: cashAccount } = await supabase
      .from('accounts')
      .select('id')
      .eq('org_id', orgId)
      .gte('account_number', '10000')
      .lt('account_number', '11000')
      .eq('is_active', true)
      .limit(1)
      .single();

    const { data: arAccount } = await supabase
      .from('accounts')
      .select('id')
      .eq('org_id', orgId)
      .gte('account_number', '12000')
      .lt('account_number', '13000')
      .eq('is_active', true)
      .limit(1)
      .single();

    let glEntryId: string | undefined;

    if (cashAccount && arAccount) {
      const jeResult = await postJournalEntry(supabase, {
        org_id: orgId,
        location_id: body.location_id,
        entry_date: body.payment_date,
        entry_type: 'STANDARD',
        memo: `Customer payment — ${body.payment_method} ${body.reference_number ?? ''}`.trim(),
        source_module: 'AR',
        created_by: userId,
        lines: [
          { account_id: cashAccount.id, debit_cents: body.amount_cents, credit_cents: 0, location_id: body.location_id },
          { account_id: arAccount.id, debit_cents: 0, credit_cents: body.amount_cents, location_id: body.location_id },
        ],
      });

      if (jeResult.success) {
        glEntryId = jeResult.entry_id;
      }
    }

    // Create payment record
    const { data: payment, error: payErr } = await supabase
      .from('customer_payments')
      .insert({
        org_id: orgId,
        customer_id: body.customer_id,
        payment_date: body.payment_date,
        amount_cents: body.amount_cents,
        payment_method: body.payment_method,
        reference_number: body.reference_number ?? null,
        bank_account_id: body.bank_account_id ?? null,
        gl_entry_id: glEntryId ?? null,
      })
      .select('id')
      .single();

    if (payErr || !payment) {
      return NextResponse.json({ error: payErr?.message ?? 'Failed to create payment' }, { status: 500 });
    }

    // Apply to invoices
    for (const app of body.applications) {
      await supabase.from('payment_applications').insert({
        org_id: orgId,
        payment_id: payment.id,
        invoice_id: app.invoice_id,
        amount_cents: app.amount_cents,
      });

      // Update invoice amount_paid_cents and status
      const { data: inv } = await supabase
        .from('invoices')
        .select('amount_paid_cents, total_cents')
        .eq('id', app.invoice_id)
        .single();

      if (inv) {
        const newPaid = Number(inv.amount_paid_cents) + app.amount_cents;
        const newStatus = newPaid >= Number(inv.total_cents) ? 'PAID' : 'PARTIALLY_PAID';
        await supabase.from('invoices')
          .update({ amount_paid_cents: newPaid, status: newStatus })
          .eq('id', app.invoice_id);
      }
    }

    return NextResponse.json({
      payment_id: payment.id,
      gl_entry_id: glEntryId ?? null,
      applications_count: body.applications.length,
    }, { status: 201 });
  } catch (error) {
    console.error('[Payment Error]', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Internal server error' }, { status: 500 });
  }
}
