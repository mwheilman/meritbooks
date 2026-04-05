export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { submitReceiptSchema, type SubmitReceiptInput } from '@/lib/validations/transactions';

export const POST = apiHandler(
  submitReceiptSchema,
  async (body: SubmitReceiptInput, ctx) => {
    const { data: receipt, error } = await ctx.supabase
      .from('receipts')
      .insert({
        org_id: ctx.orgId,
        location_id: body.location_id,
        source: body.source,
        image_url: body.image_url,
        vendor_name: body.vendor_name,
        amount_cents: body.amount_cents,
        receipt_date: body.receipt_date,
        account_id: body.account_id,
        department_id: body.department_id,
        submitted_by: ctx.userId,
        status: 'PENDING',
      })
      .select('id')
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // TODO: Trigger AI categorization asynchronously
    // await categorizeReceipt(ctx.supabase, receipt.id);

    return NextResponse.json({ receipt_id: receipt.id }, { status: 201 });
  }
);
