import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { bankFeedQuerySchema, type BankFeedQuery } from '@/lib/validations/transactions';

/**
 * GET /api/bank-feed
 * List bank transactions with status filter, search, pagination, status counts, and metrics.
 */
export const GET = apiQueryHandler(
  bankFeedQuerySchema,
  async (params: BankFeedQuery, ctx) => {
    const page = parseInt(params.page ?? '1', 10);
    const perPage = Math.min(parseInt(params.per_page ?? '50', 10), 100);
    const offset = (page - 1) * perPage;

    // Build the data query with joins
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
        match_confidence,
        matched_bill_id,
        matched_receipt_id,
        location:locations!bank_transactions_location_id_fkey(id, name, short_code),
        ai_account:accounts!bank_transactions_ai_account_id_fkey(id, account_number, name, account_type),
        ai_vendor:vendors!bank_transactions_ai_vendor_id_fkey(id, name, display_name),
        final_account:accounts!bank_transactions_final_account_id_fkey(id, account_number, name, account_type),
        final_job:jobs!bank_transactions_final_job_id_fkey(id, job_number, name),
        matched_bill:bills!fk_matched_bill(id, bill_number)
      `, { count: 'exact' });

    // Location filter (company selector)
    if (params.location_id) {
      query = query.eq('location_id', params.location_id);
    }

    // Status filter
    if (params.status && params.status !== 'all') {
      query = query.eq('status', params.status);
    } else {
      // Default: show actionable transactions (exclude already-processed)
      query = query.in('status', ['PENDING', 'CATEGORIZED', 'FLAGGED', 'APPROVED']);
    }

    // Search on description (bank descriptions contain vendor name fragments)
    if (params.search && params.search.trim().length > 0) {
      query = query.ilike('description', `%${params.search.trim()}%`);
    }

    // Default sort: confidence ascending (lowest first = needs most attention)
    query = query
      .order('ai_confidence', { ascending: true, nullsFirst: true })
      .order('transaction_date', { ascending: false })
      .range(offset, offset + perPage - 1);

    const { data, error, count } = await query;

    if (error) {
      console.error('[bank-feed] Query error:', error.message, error.details, error.hint);
      return NextResponse.json(
        { error: error.message, code: 'QUERY_ERROR' },
        { status: 500 }
      );
    }

    // Status counts + dollar sums + metrics (parallel queries)
    // Respect location filter so counts match the displayed data
    const today = new Date().toISOString().split('T')[0];
    const statuses = ['PENDING', 'CATEGORIZED', 'FLAGGED'] as const;
    const loc = params.location_id;

    const pendingQ = ctx.supabase.from('bank_transactions').select('amount_cents').eq('status', 'PENDING');
    const catQ = ctx.supabase.from('bank_transactions').select('amount_cents').eq('status', 'CATEGORIZED');
    const flagQ = ctx.supabase.from('bank_transactions').select('amount_cents').eq('status', 'FLAGGED');
    const todayAllQ = ctx.supabase.from('bank_transactions').select('id', { count: 'exact', head: true }).gte('created_at', today);
    const todayPostedQ = ctx.supabase.from('bank_transactions').select('id', { count: 'exact', head: true }).gte('approved_at', today).in('status', ['POSTED', 'APPROVED']);

    const [countPending, countCategorized, countFlagged, todayAll, todayPosted] = await Promise.all([
      loc ? pendingQ.eq('location_id', loc) : pendingQ,
      loc ? catQ.eq('location_id', loc) : catQ,
      loc ? flagQ.eq('location_id', loc) : flagQ,
      loc ? todayAllQ.eq('location_id', loc) : todayAllQ,
      loc ? todayPostedQ.eq('location_id', loc) : todayPostedQ,
    ]);

    const countResults = [countPending, countCategorized, countFlagged];
    const statusCounts: Record<string, { count: number; amount_cents: number }> = {};
    let totalCount = 0;
    let totalAmount = 0;

    statuses.forEach((s, i) => {
      const rows = countResults[i].data ?? [];
      const cnt = rows.length;
      const amt = rows.reduce((sum: number, r: { amount_cents: number }) => sum + Math.abs(Number(r.amount_cents)), 0);
      statusCounts[s] = { count: cnt, amount_cents: amt };
      totalCount += cnt;
      totalAmount += amt;
    });

    statusCounts['all'] = { count: totalCount, amount_cents: totalAmount };

    // Compute avg confidence from returned data
    const confidences = (data ?? [])
      .map((r: { ai_confidence: number | null }) => r.ai_confidence)
      .filter((c): c is number => c != null);
    const avgConf = confidences.length > 0
      ? confidences.reduce((a: number, b: number) => a + b, 0) / confidences.length
      : 0;

    const metrics = {
      total_today: todayAll.count ?? 0,
      reviewed_today: todayPosted.count ?? 0,
      auto_approved_today: 0, // TODO: track auto-approvals separately
      avg_confidence: Math.round(avgConf * 100) / 100,
    };

    return NextResponse.json({
      data: data ?? [],
      counts: statusCounts,
      metrics,
      pagination: {
        page,
        per_page: perPage,
        total: count ?? 0,
        total_pages: Math.ceil((count ?? 0) / perPage),
      },
    });
  }
);
