import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { flagTransactionSchema, type FlagTransactionInput } from '@/lib/validations/transactions';

/**
 * POST /api/bank-feed/flag
 * Flag a bank transaction for manager review with a reason note.
 * Only PENDING and CATEGORIZED transactions can be flagged.
 */
export const POST = apiHandler(
  flagTransactionSchema,
  async (body: FlagTransactionInput, ctx) => {
    // Verify the transaction exists and is in a flaggable state
    const { data: txn, error: fetchError } = await ctx.supabase
      .from('bank_transactions')
      .select('id, status, description')
      .eq('id', body.transaction_id)
      .single();

    if (fetchError || !txn) {
      return NextResponse.json(
        { error: 'Transaction not found', code: 'NOT_FOUND' },
        { status: 404 }
      );
    }

    if (txn.status === 'POSTED' || txn.status === 'APPROVED') {
      return NextResponse.json(
        { error: 'Cannot flag an already-approved transaction', code: 'INVALID_STATUS' },
        { status: 400 }
      );
    }

    if (txn.status === 'FLAGGED') {
      return NextResponse.json(
        { error: 'Transaction is already flagged', code: 'ALREADY_FLAGGED' },
        { status: 400 }
      );
    }

    // Update status to FLAGGED and append the user's reason to ai_reasoning
    const { error: updateError } = await ctx.supabase
      .from('bank_transactions')
      .update({
        status: 'FLAGGED',
        ai_reasoning: `Flagged by user: ${body.reason}`,
      })
      .eq('id', body.transaction_id);

    if (updateError) {
      return NextResponse.json(
        { error: updateError.message, code: 'UPDATE_ERROR' },
        { status: 500 }
      );
    }

    // Audit log
    await ctx.supabase.from('audit_log').insert({
      org_id: ctx.orgId ?? undefined,
      table_name: 'bank_transactions',
      record_id: body.transaction_id,
      action: 'UPDATE',
      field_name: 'status',
      old_value: txn.status,
      new_value: 'FLAGGED',
      user_id: ctx.userId,
      metadata: JSON.stringify({ reason: body.reason }),
    });

    return NextResponse.json({
      success: true,
      transaction_id: body.transaction_id,
      status: 'FLAGGED',
    });
  }
);
