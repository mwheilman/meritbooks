import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { z } from 'zod';

const ccQuerySchema = z.object({
  status: z.enum(['all', 'PENDING', 'CATEGORIZED', 'FLAGGED', 'APPROVED']).optional(),
  search: z.string().max(200).optional(),
  location_id: z.string().uuid().optional(),
  page: z.string().regex(/^\d+$/).optional(),
  per_page: z.string().regex(/^\d+$/).optional(),
});

/**
 * GET /api/credit-cards
 * List credit card transactions — bank_transactions where
 * the bank_account.account_type = 'CREDIT_CARD'.
 * Includes receipt matching status and chase count.
 */
export const GET = apiQueryHandler(
  ccQuerySchema,
  async (params, ctx) => {
    const page = parseInt(params.page ?? '1', 10);
    const perPage = Math.min(parseInt(params.per_page ?? '50', 10), 100);
    const offset = (page - 1) * perPage;

    // First, get credit card bank account IDs
    let ccAccountsQuery = ctx.supabase
      .from('bank_accounts')
      .select('id')
      .eq('account_type', 'CREDIT_CARD')
      .eq('is_active', true);

    if (params.location_id) {
      ccAccountsQuery = ccAccountsQuery.eq('location_id', params.location_id);
    }

    const { data: ccAccounts } = await ccAccountsQuery;
    const ccAccountIds = (ccAccounts ?? []).map((a: { id: string }) => a.id);

    if (ccAccountIds.length === 0) {
      return NextResponse.json({
        data: [],
        counts: {
          all: { count: 0, amount_cents: 0 },
          PENDING: { count: 0, amount_cents: 0 },
          CATEGORIZED: { count: 0, amount_cents: 0 },
          FLAGGED: { count: 0, amount_cents: 0 },
        },
        pagination: { page, per_page: perPage, total: 0, total_pages: 0 },
      });
    }

    // Main query
    let query = ctx.supabase
      .from('bank_transactions')
      .select(`
        id,
        transaction_date,
        created_at,
        description,
        amount_cents,
        status,
        ai_confidence,
        ai_reasoning,
        match_type,
        matched_receipt_id,
        location:locations!bank_transactions_location_id_fkey(id, name, short_code),
        ai_account:accounts!bank_transactions_ai_account_id_fkey(id, account_number, name, account_type),
        ai_vendor:vendors!bank_transactions_ai_vendor_id_fkey(id, name, display_name),
        final_account:accounts!bank_transactions_final_account_id_fkey(id, account_number, name, account_type),
        bank_account:bank_accounts!bank_transactions_bank_account_id_fkey(id, account_name, account_mask)
      `, { count: 'exact' })
      .in('bank_account_id', ccAccountIds);

    // Status filter
    if (params.status && params.status !== 'all') {
      query = query.eq('status', params.status);
    } else {
      query = query.in('status', ['PENDING', 'CATEGORIZED', 'FLAGGED', 'APPROVED']);
    }

    if (params.search && params.search.trim().length > 0) {
      query = query.ilike('description', `%${params.search.trim()}%`);
    }

    query = query
      .order('ai_confidence', { ascending: true, nullsFirst: true })
      .order('transaction_date', { ascending: false })
      .range(offset, offset + perPage - 1);

    const { data, error, count } = await query;

    if (error) {
      console.error('[credit-cards] Query error:', error);
      return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
    }

    // Get receipt matching info for transactions that have matched_receipt_id
    const txnIds = (data ?? []).map((t: { id: string }) => t.id);
    let receiptMap: Record<string, { chase_reminder_count: number; status: string }> = {};

    if (txnIds.length > 0) {
      const { data: receipts } = await ctx.supabase
        .from('receipts')
        .select('bank_transaction_id, chase_reminder_count, status')
        .in('bank_transaction_id', txnIds);

      if (receipts) {
        for (const r of receipts) {
          if (r.bank_transaction_id) {
            receiptMap[r.bank_transaction_id] = {
              chase_reminder_count: r.chase_reminder_count ?? 0,
              status: r.status,
            };
          }
        }
      }
    }

    // Transform data — add receipt status
    const rows = (data ?? []).map((t: any) => {
      const receipt = receiptMap[t.id];
      let receiptStatus: 'MATCHED' | 'MISSING' | 'PENDING' = 'MISSING';
      if (t.matched_receipt_id) {
        receiptStatus = 'MATCHED';
      } else if (receipt) {
        receiptStatus = receipt.status === 'APPROVED' || receipt.status === 'POSTED' ? 'MATCHED' : 'PENDING';
      }

      return {
        ...t,
        receiptStatus,
        chaseCount: receipt?.chase_reminder_count ?? 0,
      };
    });

    // Status counts
    const statuses = ['PENDING', 'CATEGORIZED', 'FLAGGED'] as const;
    const statusCounts: Record<string, { count: number; amount_cents: number }> = {};
    let totalCount = 0;
    let totalAmount = 0;

    for (const s of statuses) {
      let q = ctx.supabase
        .from('bank_transactions')
        .select('amount_cents')
        .eq('status', s)
        .in('bank_account_id', ccAccountIds);
      if (params.location_id) q = q.eq('location_id', params.location_id);
      const { data: sRows } = await q;
      const cnt = (sRows ?? []).length;
      const amt = (sRows ?? []).reduce((sum: number, r: { amount_cents: number }) => sum + Math.abs(Number(r.amount_cents)), 0);
      statusCounts[s] = { count: cnt, amount_cents: amt };
      totalCount += cnt;
      totalAmount += amt;
    }
    statusCounts['all'] = { count: totalCount, amount_cents: totalAmount };

    return NextResponse.json({
      data: rows,
      counts: statusCounts,
      pagination: {
        page,
        per_page: perPage,
        total: count ?? 0,
        total_pages: Math.ceil((count ?? 0) / perPage),
      },
    });
  }
);
