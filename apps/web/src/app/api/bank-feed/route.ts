export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { bankFeedQuerySchema, type BankFeedQuery } from '@/lib/validations/transactions';

/**
 * GET /api/bank-feed
 * List bank transactions with status filter, search, pagination, status counts, and metrics.
 *
 * NOTE (schema carve): `locations`, `vendors`, and `jobs` live in the `core`
 * schema (migration 019/020). PostgREST cannot embed across the core<->public
 * boundary, so we DO NOT embed those here — embedding them returns a query error
 * and an empty feed (this is why imported transactions didn't appear). Instead we
 * select only same-schema (public) embeds (accounts, bills) and stitch the
 * core-schema references (location, vendor, job) in JS.
 */
export const GET = apiQueryHandler(
  bankFeedQuerySchema,
  async (params: BankFeedQuery, ctx) => {
    const page = parseInt(params.page ?? '1', 10);
    const perPage = Math.min(parseInt(params.per_page ?? '50', 10), 100);
    const offset = (page - 1) * perPage;

    // Same-schema (public) embeds only. Core-schema refs are fetched separately below.
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
        location_id,
        ai_vendor_id,
        final_job_id,
        ai_account:accounts!bank_transactions_ai_account_id_fkey(id, account_number, name, account_type),
        final_account:accounts!bank_transactions_final_account_id_fkey(id, account_number, name, account_type),
        matched_bill:bills!fk_matched_bill(id, bill_number)
      `, { count: 'exact' });

    if (params.location_id) {
      query = query.eq('location_id', params.location_id);
    }

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
      console.error('[bank-feed] Query error:', error.message, error.details, error.hint);
      return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
    }

    type Row = {
      location_id: string | null;
      ai_vendor_id: string | null;
      final_job_id: string | null;
      ai_confidence: number | null;
      [k: string]: unknown;
    };
    const rows = (data ?? []) as Row[];

    // ---- Stitch core-schema references in JS (no cross-schema embeds) ----
    const locationIds = [...new Set(rows.map((r) => r.location_id).filter((v): v is string => !!v))];
    const vendorIds = [...new Set(rows.map((r) => r.ai_vendor_id).filter((v): v is string => !!v))];
    const jobIds = [...new Set(rows.map((r) => r.final_job_id).filter((v): v is string => !!v))];

    const [locsRes, vendorsRes, jobsRes] = await Promise.all([
      locationIds.length
        ? ctx.supabase.schema('core').from('locations').select('id, name, short_code').in('id', locationIds)
        : Promise.resolve({ data: [] as Array<{ id: string; name: string; short_code: string }> }),
      vendorIds.length
        ? ctx.supabase.schema('core').from('vendors').select('id, name, display_name').in('id', vendorIds)
        : Promise.resolve({ data: [] as Array<{ id: string; name: string; display_name: string | null }> }),
      jobIds.length
        ? ctx.supabase.schema('core').from('jobs').select('id, job_number, name').in('id', jobIds)
        : Promise.resolve({ data: [] as Array<{ id: string; job_number: string; name: string }> }),
    ]);

    const locById = new Map((locsRes.data ?? []).map((l) => [l.id, l]));
    const venById = new Map((vendorsRes.data ?? []).map((v) => [v.id, v]));
    const jobById = new Map((jobsRes.data ?? []).map((j) => [j.id, j]));

    const stitched = rows.map((r) => ({
      ...r,
      location: r.location_id ? locById.get(r.location_id) ?? null : null,
      ai_vendor: r.ai_vendor_id ? venById.get(r.ai_vendor_id) ?? null : null,
      final_job: r.final_job_id ? jobById.get(r.final_job_id) ?? null : null,
    }));

    // ---- Status counts + metrics (respect the location filter) ----
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
      const cr = (countResults[i].data ?? []) as Array<{ amount_cents: number }>;
      const cnt = cr.length;
      const amt = cr.reduce((sum: number, r: { amount_cents: number }) => sum + Math.abs(Number(r.amount_cents)), 0);
      statusCounts[s] = { count: cnt, amount_cents: amt };
      totalCount += cnt;
      totalAmount += amt;
    });
    statusCounts['all'] = { count: totalCount, amount_cents: totalAmount };

    const confidences = stitched
      .map((r) => r.ai_confidence)
      .filter((c): c is number => c != null);
    const avgConf = confidences.length > 0 ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0;

    const metrics = {
      total_today: todayAll.count ?? 0,
      reviewed_today: todayPosted.count ?? 0,
      auto_approved_today: 0,
      avg_confidence: Math.round(avgConf * 100) / 100,
    };

    return NextResponse.json({
      data: stitched,
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
