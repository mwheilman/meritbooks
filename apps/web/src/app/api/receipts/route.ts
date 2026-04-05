import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { z } from 'zod';

const receiptQuerySchema = z.object({
  status: z.enum(['all', 'PENDING', 'CATEGORIZED', 'FLAGGED', 'APPROVED']).optional(),
  search: z.string().max(200).optional(),
  location_id: z.string().uuid().optional(),
  page: z.string().regex(/^\d+$/).optional(),
  per_page: z.string().regex(/^\d+$/).optional(),
});

export const GET = apiQueryHandler(
  receiptQuerySchema,
  async (params, ctx) => {
    const page = parseInt(params.page ?? '1', 10);
    const perPage = Math.min(parseInt(params.per_page ?? '50', 10), 100);
    const offset = (page - 1) * perPage;

    let query = ctx.supabase
      .from('receipts')
      .select(`
        id,
        submitted_at,
        receipt_date,
        vendor_name,
        amount_cents,
        source,
        status,
        ai_confidence,
        chase_reminder_count,
        location:locations!receipts_location_id_fkey(id, name, short_code),
        account:accounts!receipts_account_id_fkey(id, account_number, name),
        vendor:vendors!receipts_vendor_id_fkey(id, name)
      `, { count: 'exact' });

    if (params.location_id) query = query.eq('location_id', params.location_id);

    if (params.status && params.status !== 'all') {
      query = query.eq('status', params.status);
    } else {
      query = query.in('status', ['PENDING', 'CATEGORIZED', 'FLAGGED', 'APPROVED']);
    }

    if (params.search && params.search.trim().length > 0) {
      query = query.ilike('vendor_name', `%${params.search.trim()}%`);
    }

    query = query
      .order('ai_confidence', { ascending: true, nullsFirst: true })
      .order('submitted_at', { ascending: false })
      .range(offset, offset + perPage - 1);

    const { data, error, count } = await query;

    if (error) {
      console.error('[receipts] Query error:', error);
      return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
    }

    // Status counts
    const statuses = ['PENDING', 'CATEGORIZED', 'FLAGGED'] as const;
    const statusCounts: Record<string, { count: number; amount_cents: number }> = {};
    let totalCount = 0;
    let totalAmount = 0;
    const loc = params.location_id;

    for (const s of statuses) {
      let q = ctx.supabase.from('receipts').select('amount_cents').eq('status', s);
      if (loc) q = q.eq('location_id', loc);
      const { data: rows } = await q;
      const cnt = (rows ?? []).length;
      const amt = (rows ?? []).reduce((sum: number, r: { amount_cents: number | null }) => sum + Math.abs(Number(r.amount_cents ?? 0)), 0);
      statusCounts[s] = { count: cnt, amount_cents: amt };
      totalCount += cnt;
      totalAmount += amt;
    }
    statusCounts['all'] = { count: totalCount, amount_cents: totalAmount };

    return NextResponse.json({
      data: data ?? [],
      counts: statusCounts,
      pagination: { page, per_page: perPage, total: count ?? 0, total_pages: Math.ceil((count ?? 0) / perPage) },
    });
  }
);
