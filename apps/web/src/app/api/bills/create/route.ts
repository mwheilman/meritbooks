import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { createBillSchema, type CreateBillInput } from '@/lib/validations/transactions';

export const POST = apiHandler(
  createBillSchema,
  async (body: CreateBillInput, ctx) => {
    const orgId = ctx.orgId ?? '';

    // Check vendor compliance
    const { data: complianceDocs } = await ctx.supabase
      .from('vendor_compliance_docs')
      .select('doc_type, status, expiration_date')
      .eq('vendor_id', body.vendor_id)
      .eq('org_id', orgId);

    const hasIssue = (complianceDocs ?? []).some(
      (doc) => doc.status === 'MISSING' || doc.status === 'EXPIRED'
    );

    const subtotalCents = body.lines.reduce((s, l) => s + l.amount_cents, 0);
    const totalCents = subtotalCents + body.tax_cents;

    // Create bill header
    const { data: bill, error: billErr } = await ctx.supabase
      .from('bills')
      .insert({
        org_id: orgId,
        location_id: body.location_id,
        vendor_id: body.vendor_id,
        bill_number: body.bill_number,
        bill_date: body.bill_date,
        due_date: body.due_date,
        subtotal_cents: subtotalCents,
        tax_cents: body.tax_cents,
        total_cents: totalCents,
        status: hasIssue ? 'ON_HOLD' : 'PENDING',
        payment_hold_reason: hasIssue ? 'Vendor compliance documents missing or expired' : null,
        ai_extracted: false,
      })
      .select('id')
      .single();

    if (billErr || !bill) {
      return NextResponse.json({ error: billErr?.message ?? 'Failed to create bill' }, { status: 500 });
    }

    // Create bill lines
    const lineInserts = body.lines.map((line, i) => ({
      org_id: orgId,
      bill_id: bill.id,
      line_number: i + 1,
      description: line.description,
      account_id: line.account_id,
      department_id: line.department_id,
      class_id: line.class_id,
      item_id: line.item_id,
      quantity: line.quantity,
      unit_cost_cents: line.unit_cost_cents,
      amount_cents: line.amount_cents,
      job_id: line.job_id,
    }));

    const { error: linesErr } = await ctx.supabase
      .from('bill_lines')
      .insert(lineInserts);

    if (linesErr) {
      // Clean up header if lines fail
      await ctx.supabase.from('bills').delete().eq('id', bill.id);
      return NextResponse.json({ error: linesErr.message }, { status: 500 });
    }

    return NextResponse.json({
      bill_id: bill.id,
      status: hasIssue ? 'ON_HOLD' : 'PENDING',
      compliance_warning: hasIssue ? 'Bill placed on hold due to vendor compliance issues' : null,
    }, { status: 201 });
  }
);
