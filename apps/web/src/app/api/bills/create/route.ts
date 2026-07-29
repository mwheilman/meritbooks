export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { createBillSchema } from '@/lib/validations/transactions';
import { createAttribution, resolveApprover } from '@/lib/services/cost-approval';

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

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

    // Vendor compliance
    const { data: complianceDocs } = await supabase
      .from('vendor_compliance_docs')
      .select('doc_type, status, expiration_date')
      .eq('vendor_id', body.vendor_id)
      .eq('org_id', orgId);

    const hasIssue = (complianceDocs ?? []).some(
      (doc) => doc.status === 'MISSING' || doc.status === 'EXPIRED'
    );

    const subtotalCents = body.lines.reduce((s, l) => s + l.amount_cents, 0);
    // Retainage is withheld on the subtotal (not tax), mirroring the AR side.
    // total_cents is the currently-due payable, NET of retainage; the withheld
    // portion is parked in Retainage Payable at approval.
    const retainageCents = body.retainage_pct > 0 ? Math.round(subtotalCents * body.retainage_pct / 100) : 0;
    const totalCents = subtotalCents + body.tax_cents - retainageCents;

    // Route the bill to an approver (by vendor, falling back to ACCOUNTING).
    const approver = await resolveApprover(supabase, orgId, { vendorId: body.vendor_id, sourceType: 'BILL' });

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
        retainage_pct: body.retainage_pct,
        retainage_cents: retainageCents,
        status: hasIssue ? 'ON_HOLD' : 'PENDING',
        payment_hold_reason: hasIssue ? 'Vendor compliance documents missing or expired' : null,
        approver_type: approver.approver_type,
        approver_ref: approver.approver_ref,
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

    const { data: insertedLines, error: linesErr } = await supabase
      .from('bill_lines')
      .insert(lineInserts)
      .select('id, line_number, account_id, amount_cents, department_id, job_id');

    if (linesErr) {
      await supabase.from('bills').delete().eq('id', bill.id);
      return NextResponse.json({ error: linesErr.message }, { status: 500 });
    }

    // Account numbers for GL_CODE routing of job-tagged lines.
    const jobLines = (insertedLines ?? []).filter((l) => (l as { job_id: string | null }).job_id);
    const acctIds = [...new Set(jobLines.map((l) => (l as { account_id: string }).account_id))];
    const acctNumberById = new Map<string, string>();
    if (acctIds.length > 0) {
      const { data: accts } = await supabase.from('accounts').select('id, account_number').in('id', acctIds);
      for (const a of accts ?? []) acctNumberById.set((a as { id: string }).id, (a as { account_number: string }).account_number);
    }

    // Each job-tagged line becomes a PENDING committed-cost attribution
    // (gate PAYABLE_APPROVAL). It clears when the bill is approved.
    let committedCosts = 0;
    const costTypeByLineNo = new Map<number, string>();
    body.lines.forEach((l, i) => costTypeByLineNo.set(i + 1, l.cost_type ?? 'MATERIALS'));

    for (const l of jobLines) {
      const lineNo = (l as { line_number: number }).line_number;
      try {
        await createAttribution(supabase, {
          orgId,
          locationId: body.location_id,
          jobId: (l as { job_id: string }).job_id,
          departmentId: (l as { department_id: string | null }).department_id ?? null,
          costType: (costTypeByLineNo.get(lineNo) ?? 'MATERIALS') as 'MATERIALS' | 'SUBCONTRACTOR' | 'EQUIPMENT' | 'OTHER',
          amountCents: (l as { amount_cents: number }).amount_cents,
          occurredOn: body.bill_date,
          gate: 'PAYABLE_APPROVAL',
          sourceType: 'BILL',
          sourceRef: (l as { id: string }).id,
          billId: bill.id,
          routing: {
            vendorId: body.vendor_id,
            accountNumber: acctNumberById.get((l as { account_id: string }).account_id) ?? null,
            sourceType: 'BILL',
          },
        });
        committedCosts++;
      } catch (e) {
        console.error('[bills/create] attribution failed', e);
        // Non-fatal: the bill + lines are saved; the committed-cost event can be retried.
      }
    }

    return NextResponse.json({
      bill_id: bill.id,
      status: hasIssue ? 'ON_HOLD' : 'PENDING',
      committed_cost_lines: committedCosts,
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
