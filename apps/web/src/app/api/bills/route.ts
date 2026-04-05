export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { z } from 'zod';

const billQuerySchema = z.object({
  status: z.enum(['all', 'PENDING', 'APPROVED', 'PARTIALLY_PAID', 'PAID', 'ON_HOLD']).optional(),
  search: z.string().max(200).optional(),
  location_id: z.string().uuid().optional(),
  page: z.string().regex(/^\d+$/).optional(),
  per_page: z.string().regex(/^\d+$/).optional(),
});

export const GET = apiQueryHandler(
  billQuerySchema,
  async (params, ctx) => {
    const page = parseInt(params.page ?? '1', 10);
    const perPage = Math.min(parseInt(params.per_page ?? '50', 10), 100);
    const offset = (page - 1) * perPage;

    let query = ctx.supabase
      .from('bills')
      .select(`
        id,
        bill_number,
        bill_date,
        due_date,
        total_cents,
        amount_paid_cents,
        balance_cents,
        status,
        ai_extracted,
        ai_confidence,
        payment_hold_reason,
        location:locations!bills_location_id_fkey(id, name, short_code),
        vendor:vendors!bills_vendor_id_fkey(id, name, display_name, is_1099_eligible)
      `, { count: 'exact' });

    if (params.location_id) query = query.eq('location_id', params.location_id);

    if (params.status && params.status !== 'all') {
      query = query.eq('status', params.status);
    } else {
      // Default: show open bills
      query = query.in('status', ['PENDING', 'APPROVED', 'PARTIALLY_PAID', 'ON_HOLD']);
    }

    if (params.search && params.search.trim().length > 0) {
      // Search vendor name via bill_number or description
      query = query.or(`bill_number.ilike.%${params.search.trim()}%`);
    }

    query = query
      .order('due_date', { ascending: true }) // Soonest due first
      .range(offset, offset + perPage - 1);

    const { data, error, count } = await query;

    if (error) {
      console.error('[bills] Query error:', error);
      return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
    }

    // Check vendor compliance for returned bills
    const vendorIds = [...new Set((data ?? []).map((b: any) => b.vendor?.id).filter(Boolean))];
    let complianceMap: Record<string, { missing: string[]; hasHold: boolean }> = {};

    if (vendorIds.length > 0) {
      // Check for missing/expired compliance docs
      const { data: docs } = await ctx.supabase
        .from('vendor_compliance_docs')
        .select('vendor_id, doc_type, expiration_date, status')
        .in('vendor_id', vendorIds);

      // Check for payment holds
      const { data: holds } = await ctx.supabase
        .from('vendor_payment_holds')
        .select('vendor_id')
        .in('vendor_id', vendorIds);

      const holdSet = new Set((holds ?? []).map((h: { vendor_id: string }) => h.vendor_id));

      for (const vid of vendorIds) {
        const vendorDocs = (docs ?? []).filter((d: any) => d.vendor_id === vid);
        const missing: string[] = [];

        // Check W-9
        const w9 = vendorDocs.find((d: any) => d.doc_type === 'W9');
        if (!w9 || w9.status !== 'CURRENT') missing.push('W-9');

        // Check GL COI
        const glCoi = vendorDocs.find((d: any) => d.doc_type === 'GL_COI');
        if (glCoi && glCoi.expiration_date && new Date(glCoi.expiration_date) < new Date()) {
          missing.push('GL COI (expired)');
        } else if (!glCoi) {
          missing.push('GL COI');
        }

        // Check WC COI
        const wcCoi = vendorDocs.find((d: any) => d.doc_type === 'WC_COI');
        if (wcCoi && wcCoi.expiration_date && new Date(wcCoi.expiration_date) < new Date()) {
          missing.push('WC COI (expired)');
        }

        if (missing.length > 0 || holdSet.has(vid)) {
          complianceMap[vid] = { missing, hasHold: holdSet.has(vid) };
        }
      }
    }

    // Enrich rows with compliance info and days until due
    const enrichedData = (data ?? []).map((bill: any) => {
      const vendorId = bill.vendor?.id;
      const compliance = vendorId ? complianceMap[vendorId] ?? null : null;
      const daysUntilDue = bill.due_date
        ? Math.ceil((new Date(bill.due_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        : null;

      return {
        ...bill,
        compliance,
        daysUntilDue,
      };
    });

    // Status counts
    const openStatuses = ['PENDING', 'APPROVED', 'PARTIALLY_PAID', 'ON_HOLD'] as const;
    const statusCounts: Record<string, { count: number; amount_cents: number }> = {};
    let totalCount = 0;
    let totalAmount = 0;

    for (const s of openStatuses) {
      let q = ctx.supabase.from('bills').select('balance_cents').eq('status', s);
      if (params.location_id) q = q.eq('location_id', params.location_id);
      const { data: rows } = await q;
      const cnt = (rows ?? []).length;
      const amt = (rows ?? []).reduce((sum: number, r: { balance_cents: number }) => sum + Math.abs(Number(r.balance_cents ?? 0)), 0);
      statusCounts[s] = { count: cnt, amount_cents: amt };
      totalCount += cnt;
      totalAmount += amt;
    }
    statusCounts['all'] = { count: totalCount, amount_cents: totalAmount };

    return NextResponse.json({
      data: enrichedData,
      counts: statusCounts,
      pagination: { page, per_page: perPage, total: count ?? 0, total_pages: Math.ceil((count ?? 0) / perPage) },
    });
  }
);
