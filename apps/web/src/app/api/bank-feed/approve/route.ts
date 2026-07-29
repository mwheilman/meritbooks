export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { approveBankTransactionSchema, type ApproveBankTransactionInput } from '@/lib/validations/transactions';
import { postJournalEntry } from '@/lib/services/gl-posting';
import { recordBillPayment } from '@/lib/posting/lifecycle';
import { createAttribution } from '@/lib/services/cost-approval';
import { learnVendorPattern } from '@/lib/services/categorization';

/**
 * POST /api/bank-feed/approve
 * Approves a bank/credit-card transaction: posts a JE, updates status, records the vendor pattern, and — when a job is
 * assigned — clears the job cost immediately (gate BANKFEED_CATEGORIZATION: the
 * cash already left) by emitting a CLEARED JOB_COST event through the cost/
 * billing seam. This is the categorization path that replaces the retired
 * standalone Cost Approvals tab for bank/card costs.
 */
export const POST = apiHandler(
  approveBankTransactionSchema,
  async (body: ApproveBankTransactionInput, ctx) => {
    // Canonical org id — the token's org_id claim (a real core.organizations.id),
    // which RLS also enforces. No lookup needed.
    const orgId = ctx.orgId ?? '';

    const { data: txn, error: txnErr } = await ctx.supabase
      .from('bank_transactions')
      .select('*, bank_accounts(location_id, account_id)')
      .eq('id', body.transaction_id)
      .single();

    if (txnErr || !txn) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
    }
    if (txn.status === 'POSTED') {
      return NextResponse.json({ error: 'Transaction already posted' }, { status: 400 });
    }

    const bankAccount = txn.bank_accounts as { location_id: string; account_id: string };
    const locationId = bankAccount.location_id;
    const cashAccountId = bankAccount.account_id;
    const isOutflow = txn.amount_cents < 0;
    const absCents = Math.abs(txn.amount_cents);

    // If this outflow settles an existing bill, clear Accounts Payable rather
    // than booking a fresh expense — the bill was already expensed at approval,
    // so re-expensing the bank line would double-count (audit gap 3).
    if (isOutflow && txn.match_type === 'BILL_PAYMENT' && txn.matched_bill_id) {
      try {
        const res = await recordBillPayment(ctx.supabase, {
          orgId,
          billId: txn.matched_bill_id as string,
          amountCents: absCents,
          paymentDate: txn.transaction_date,
          method: 'OTHER',
          cashAccountId, // post the cash side to the actual bank account
          bankTransactionId: txn.id,
          createdBy: null,
        });
        await ctx.supabase
          .from('bank_transactions')
          .update({
            status: 'POSTED',
            match_type: 'BILL_PAYMENT',
            matched_bill_id: txn.matched_bill_id,
            approved_at: new Date().toISOString(),
            gl_entry_id: res.gl_entry_id,
          })
          .eq('id', body.transaction_id);
        return NextResponse.json(
          { success: true, settled_bill: true, bill_payment_id: res.payment_id, transaction_id: body.transaction_id },
          { status: 200 }
        );
      } catch (e) {
        return NextResponse.json(
          { error: e instanceof Error ? e.message : 'Bill settlement failed' },
          { status: 400 }
        );
      }
    }

    // Periods are a product of setup, not auto-created here (suite contract Rule F):
    // postJournalEntry rejects a missing/closed period with a clear error.
    const lines = isOutflow
      ? [
          { account_id: body.account_id, debit_cents: absCents, credit_cents: 0, location_id: locationId, department_id: body.department_id ?? undefined, class_id: body.class_id ?? undefined },
          { account_id: cashAccountId, debit_cents: 0, credit_cents: absCents, location_id: locationId },
        ]
      : [
          { account_id: cashAccountId, debit_cents: absCents, credit_cents: 0, location_id: locationId },
          { account_id: body.account_id, debit_cents: 0, credit_cents: absCents, location_id: locationId, department_id: body.department_id ?? undefined, class_id: body.class_id ?? undefined },
        ];

    const jeResult = await postJournalEntry(ctx.supabase, {
      org_id: orgId,
      location_id: locationId,
      entry_date: txn.transaction_date,
      entry_type: 'STANDARD',
      memo: `Bank feed: ${txn.description}`,
      source_module: 'BANK_FEED',
      source_id: txn.id,
      created_by: null, // Clerk user id is text; gl_entries.created_by is uuid (nullable per migration 018). No core.users mapping yet.
      lines,
    });

    if (!jeResult.success) {
      return NextResponse.json({ error: jeResult.error }, { status: 400 });
    }

    await ctx.supabase
      .from('bank_transactions')
      .update({
        status: 'POSTED',
        final_account_id: body.account_id,
        final_vendor_id: body.vendor_id,
        final_department_id: body.department_id,
        final_class_id: body.class_id,
        final_job_id: body.job_id ?? null,
        approved_by: null, // uuid column; Clerk text id has no uuid mapping yet
        approved_at: new Date().toISOString(),
        gl_entry_id: jeResult.entry_id,
      })
      .eq('id', body.transaction_id);

    // Job-tagged categorization → clear the cost now (cash already spent).
    if (body.job_id && jeResult.entry_id) {
      const { data: expenseLine } = await ctx.supabase
        .from('gl_entry_lines')
        .select('id')
        .eq('gl_entry_id', jeResult.entry_id)
        .eq('account_id', body.account_id)
        .single();

      const glLineId = (expenseLine as { id: string } | null)?.id ?? null;

      if (glLineId) {
        await ctx.supabase.from('gl_entry_lines').update({ job_id: body.job_id }).eq('id', glLineId);
        await ctx.supabase.from('job_cost_entries').insert({
          org_id: orgId,
          job_id: body.job_id,
          gl_entry_line_id: glLineId,
          amount_cents: absCents,
          description: `Bank feed: ${txn.description}`,
          entry_date: txn.transaction_date,
        });
      }

      // Seam: emit a CLEARED JOB_COST event (gate BANKFEED_CATEGORIZATION).
      try {
        await createAttribution(ctx.supabase, {
          orgId,
          locationId,
          jobId: body.job_id,
          departmentId: body.department_id ?? null,
          costType: 'MATERIALS',
          amountCents: absCents,
          occurredOn: txn.transaction_date,
          gate: 'BANKFEED_CATEGORIZATION',
          sourceType: 'BANK_TXN',
          sourceRef: txn.id,
          glEntryId: jeResult.entry_id,
        });
      } catch (e) {
        console.error('[bank-feed/approve] JOB_COST emit failed (non-fatal)', e);
      }
    }

    // Vendor pattern learning. Routed through learnVendorPattern so it upserts on
    // the (org_id, normalized_description) key migration 040 introduced — a raw
    // upsert on the old (org_id, vendor_id, normalized_description) target would
    // now collide with that index when two vendors share a description.
    if (body.vendor_id) {
      await learnVendorPattern(ctx.supabase, {
        orgId,
        description: txn.description,
        accountId: body.account_id,
        vendorId: body.vendor_id,
        departmentId: body.department_id ?? null,
        classId: body.class_id ?? null,
        locationId,
      });

      await ctx.supabase.rpc('increment_vendor_stats', {
        p_vendor_id: body.vendor_id,
        p_amount_cents: absCents,
      });
    }

    return NextResponse.json({
      success: true,
      entry_number: jeResult.entry_number,
      transaction_id: body.transaction_id,
    }, { status: 200 });
  }
);
