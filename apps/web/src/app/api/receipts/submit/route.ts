export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { assertOrgRefs, assertWriteScope, isWriteScopeError, serviceWriter } from '@/lib/db/scoped-writer';
import { submitReceiptSchema, type SubmitReceiptInput } from '@/lib/validations/transactions';

export const POST = apiHandler(
  submitReceiptSchema,
  async (body: SubmitReceiptInput, ctx) => {
    const orgId = ctx.orgId;
    if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

    // Capturing a receipt is receipt data entry (same tier as expense-report lines).
    const guard = await requirePermission(ctx.userId, 'receipts', 'edit');
    if (!guard.ok) return guard.response;

    // receipts is SELECT-only for members (migration 172): service-role insert after the
    // receipts:edit check, org pinned; the client + body FKs are verified in this org first.
    try {
      await assertWriteScope(ctx.supabase, orgId, [body.location_id]);
      await assertOrgRefs(
        orgId,
        [
          { table: 'accounts', ids: [body.account_id], label: 'account' },
          { schema: 'core', table: 'departments', ids: [body.department_id], label: 'department' },
        ],
        { caller: ctx.supabase },
      );
    } catch (e) {
      if (isWriteScopeError(e)) return NextResponse.json({ error: e.message }, { status: 403 });
      throw e;
    }

    const { data: receipt, error } = await serviceWriter()
      .from('receipts')
      .insert({
        org_id: orgId,
        location_id: body.location_id,
        source: body.source,
        image_url: body.image_url,
        vendor_name: body.vendor_name,
        amount_cents: body.amount_cents,
        receipt_date: body.receipt_date,
        account_id: body.account_id,
        department_id: body.department_id,
        // receipts.submitted_by is a legacy uuid column; Clerk ids are text (mig 181).
        submitted_by: null,
        submitted_by_user: ctx.userId,
        status: 'PENDING',
      })
      .select('id')
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Files go through POST /api/receipts/upload (store → read → match); this route records
    // a receipt from typed fields only. AI coding runs from Receipts → "AI categorize".
    return NextResponse.json({ receipt_id: receipt.id }, { status: 201 });
  }
);
