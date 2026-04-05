export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { createBillSchema } from '@/lib/validations/transactions';

export async function POST(request: Request) {
  const authResult = await auth().catch(() => ({ userId: null as string | null, orgId: null as string | null }));
  const orgId = authResult.orgId ?? '';

  try {
    const raw = await request.json();
    const result = createBillSchema.safeParse(raw);

    if (!result.success) {
      const errors: Record<string, string[]> = {};
      for (const issue of result.error.issues) {
        const path = issue.path.join('.') || '_root';
        if (!errors[path]) errors[path] = [];
        errors[path].push(issue.message);
      }
      return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: errors }, { status: 422 });
    }

    const body = result.data;
    const supabase = createAdminSupabase();

    // Check vendor compliance
    const { data: complianceDocs } = await supabase
      .from('vendor_compliance_docs')
      .select('doc_type, status, expiration_date')
      .eq('vendor_id', body.vendor_id)
      .eq('org_id', orgId);

    const hasIssue = (complianceDocs ?? []).some(
      (doc) => doc.status === 'MISSING' || doc.status === 'EXPIRED'
    );

    const subtotalCents = body.lines.reduce((s, l) => s + l.amount_cents, 0);
    const totalCents = subtotalCents + body.tax_cents;

    const { data: bill, error: billErr } = await supabase
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

    const lineInserts = body.lines.map((line, i) => ({
      org_id: orgId,
      bill_id: bill.id,
      line_number: i + 1,
      description: line.description,
      account_id: line.account_id,
      department_id: line.department_id ?? null,
      class_id: line.class_id ?? null,
      item_id: line.item_id ?? null,
      quantity: line.quantity,
      unit_cost_cents: line.unit_cost_cents,
      amount_cents: line.amount_cents,
      job_id: line.job_id ?? null,
    }));

    const { error: linesErr } = await supabase
      .from('bill_lines')
      .insert(lineInserts);

    if (linesErr) {
      await supabase.from('bills').delete().eq('id', bill.id);
      return NextResponse.json({ error: linesErr.message }, { status: 500 });
    }

    return NextResponse.json({
      bill_id: bill.id,
      status: hasIssue ? 'ON_HOLD' : 'PENDING',
      compliance_warning: hasIssue ? 'Bill placed on hold due to vendor compliance issues' : null,
    }, { status: 201 });
  } catch (error) {
    console.error('[Bill Create Error]', error);
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Internal server error', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
