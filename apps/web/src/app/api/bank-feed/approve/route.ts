import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { approveBankTransactionSchema, type ApproveBankTransactionInput } from '@/lib/validations/transactions';
import { postJournalEntry } from '@/lib/services/gl-posting';

/**
 * POST /api/bank-feed/approve
 * Approves a bank transaction: creates a JE, updates status, and records the pattern.
 */
export const POST = apiHandler(
  approveBankTransactionSchema,
  async (body: ApproveBankTransactionInput, ctx) => {
    const orgId = ctx.orgId ?? '';

    // Fetch the transaction
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

    // Post the journal entry
    // Outflow: DR Expense, CR Cash
    // Inflow: DR Cash, CR Revenue/Liability
    const lines = isOutflow
      ? [
          { account_id: body.account_id, debit_cents: absCents, credit_cents: 0, location_id: locationId, department_id: body.department_id, class_id: body.class_id },
          { account_id: cashAccountId, debit_cents: 0, credit_cents: absCents, location_id: locationId },
        ]
      : [
          { account_id: cashAccountId, debit_cents: absCents, credit_cents: 0, location_id: locationId },
          { account_id: body.account_id, debit_cents: 0, credit_cents: absCents, location_id: locationId, department_id: body.department_id, class_id: body.class_id },
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

    // Update the transaction
    await ctx.supabase
      .from('bank_transactions')
      .update({
        status: 'POSTED',
        final_account_id: body.account_id,
        final_vendor_id: body.vendor_id,
        final_department_id: body.department_id,
        final_class_id: body.class_id,
        approved_by: ctx.userId,
        approved_at: new Date().toISOString(),
        gl_entry_id: jeResult.entry_id,
      })
      .eq('id', body.transaction_id);

    // Update vendor pattern cache (learning)
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
      }, {
        onConflict: 'org_id,vendor_id,normalized_description',
      });

      // Increment vendor transaction count
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
