export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { z } from 'zod';
import { fetchCoreMap } from '@/lib/stitch-core';
import { fetchSplitSummaries, type SplitSummary } from '@/lib/bank/splits/service';

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
 * Includes the receipt chase status (migration 181 receipt_charge_states) and the chase
 * count (the receipt request's sends).
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
        location_id, ai_vendor_id,
        ai_account:accounts!bank_transactions_ai_account_id_fkey(id, account_number, name, account_type),
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

    // Receipt status + chase count come from the receipt chase (migration 181): the charge
    // state (needed / requested / matched / not required …) and its request's send count.
    const txnIds = (data ?? []).map((t: { id: string }) => t.id);
    const chaseMap: Record<string, { status: string; chase_count: number; request_id: string | null }> = {};
    const sendsByRequest: Record<string, number> = {};
    if (txnIds.length > 0) {
      const { data: states } = await ctx.supabase
        .from('receipt_charge_states')
        .select('bank_transaction_id, status, chase_count, request_id')
        .in('bank_transaction_id', txnIds);
      for (const s of (states ?? []) as Array<{ bank_transaction_id: string; status: string; chase_count: number; request_id: string | null }>) {
        chaseMap[s.bank_transaction_id] = { status: s.status, chase_count: s.chase_count ?? 0, request_id: s.request_id };
      }
      const reqIds = Object.values(chaseMap).map((s) => s.request_id).filter((x): x is string => !!x);
      if (reqIds.length > 0) {
        const { data: reqs } = await ctx.supabase.schema('core').from('requests').select('id, sends_count').in('id', reqIds);
        for (const r of (reqs ?? []) as Array<{ id: string; sends_count: number }>) sendsByRequest[r.id] = r.sends_count ?? 0;
      }
    }

    // Stitch core entities (locations / vendors) — cross-schema embeds don't work.
    const locMap = await fetchCoreMap<{ id: string; name: string; short_code: string }>(
      ctx.supabase, 'locations', 'id, name, short_code', (data ?? []).map((t: any) => t.location_id));
    const venMap = await fetchCoreMap<{ id: string; name: string; display_name: string | null }>(
      ctx.supabase, 'vendors', 'id, name, display_name', (data ?? []).map((t: any) => t.ai_vendor_id));

    // "Split · 3 lines" (FPB-bank-feed-splits) — card lines split through the same path.
    const splitById = await fetchSplitSummaries(ctx.supabase, txnIds).catch(() => new Map<string, SplitSummary>());

    // Transform data — add receipt status + stitched entities
    const rows = (data ?? []).map((t: any) => {
      const chase = chaseMap[t.id];
      let receiptStatus: 'MATCHED' | 'MISSING' | 'PENDING' | 'NOT_REQUIRED' = 'MISSING';
      if (t.matched_receipt_id || chase?.status === 'matched') receiptStatus = 'MATCHED';
      else if (chase && (chase.status === 'not_required' || chase.status === 'below_threshold')) receiptStatus = 'NOT_REQUIRED';
      else if (chase?.status === 'requested') receiptStatus = 'PENDING';
      const chaseCount = chase?.request_id ? sendsByRequest[chase.request_id] ?? chase.chase_count : chase?.chase_count ?? 0;

      return {
        ...t,
        location: t.location_id ? locMap.get(t.location_id) ?? null : null,
        ai_vendor: t.ai_vendor_id ? venMap.get(t.ai_vendor_id) ?? null : null,
        receiptStatus,
        receiptChaseState: chase?.status ?? null,
        chaseCount,
        split: splitById.get(t.id) ?? null,
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
