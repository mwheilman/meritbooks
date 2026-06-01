export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { approveBankTransactionSchema, type ApproveBankTransactionInput } from '@/lib/validations/transactions';
import { postJournalEntry } from '@/lib/services/gl-posting';
import { createAttribution } from '@/lib/services/cost-approval';

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
    // Canonical org id (matches fiscal_periods + the cost/billing seam tables).
    const { data: coreOrg } = await ctx.supabase.schema('core').from('organizations').select('id').limit(1).single();
    const orgId = (coreOrg as { id: string } | null)?.id ?? ctx.orgId ?? '';

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
      created_by: ctx.userId,
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
        approved_by: ctx.userId,
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

    // Vendor pattern learning
    if (body.vendor_id) {
      const normalized = txn.description.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
      await ctx.supabase.from('vendor_patterns').upsert({
        org_id: orgId,
        vendor_id: body.vendor_id,
        raw_description: txn.description,
        normalized_description: normalized,
        account_id: body.account_id,
        department_id: body.department_id ?? null,
        class_id: body.class_id ?? null,
        location_id: locationId,
        match_count: 1,
        last_matched_at: new Date().toISOString(),
      }, { onConflict: 'org_id,vendor_id,normalized_description' });

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
