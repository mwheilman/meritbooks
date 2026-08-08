export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { z } from 'zod';
import { fetchCoreMap } from '@/lib/stitch-core';
import { getHomeCurrency } from '@/lib/currency';

const billQuerySchema = z.object({
  status: z.enum(['all', 'PENDING', 'APPROVED', 'SCHEDULED', 'PARTIALLY_PAID', 'PAID', 'ON_HOLD']).optional(),
  search: z.string().max(200).optional(),
  location_id: z.string().uuid().optional(),
  page: z.string().regex(/^\d+$/).optional(),
  per_page: z.string().regex(/^\d+$/).optional(),
});

const OPEN_STATUSES = ['PENDING', 'APPROVED', 'SCHEDULED', 'PARTIALLY_PAID', 'ON_HOLD'] as const;

export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { searchParams } = new URL(request.url);
  const parsed = billQuerySchema.safeParse(Object.fromEntries(searchParams.entries()));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid query parameters', code: 'VALIDATION_ERROR' }, { status: 422 });
  }
  const params = parsed.data;

  const page = parseInt(params.page ?? '1', 10);
  const perPage = Math.min(parseInt(params.per_page ?? '50', 10), 100);
  const offset = (page - 1) * perPage;

  let query = supabase
    .from('bills')
    .select(`
      id, bill_number, bill_date, due_date,
      total_cents, amount_paid_cents, balance_cents,
      status, ai_extracted, ai_confidence, payment_hold_reason,
      approver_type, approver_ref, scheduled_payment_date,
      currency, location_id, vendor_id
    `, { count: 'exact' })
    .eq('org_id', orgId);

  if (params.location_id) query = query.eq('location_id', params.location_id);

  if (params.status && params.status !== 'all') {
    query = query.eq('status', params.status);
  } else {
    query = query.in('status', OPEN_STATUSES as unknown as string[]);
  }

  if (params.search && params.search.trim().length > 0) {
    query = query.or(`bill_number.ilike.%${params.search.trim()}%`);
  }

  query = query.order('due_date', { ascending: true }).range(offset, offset + perPage - 1);

  const { data, error, count } = await query;
  if (error) {
    console.error('[bills] Query error:', error);
    return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
  }

  const billsRaw = (data ?? []) as Array<Record<string, any>>;

  // Stitch core entities (locations / vendors) — cross-schema embeds don't work.
  const locMap = await fetchCoreMap<{ id: string; name: string; short_code: string }>(
    supabase, 'locations', 'id, name, short_code', billsRaw.map((b) => b.location_id));
  const venMap = await fetchCoreMap<{ id: string; name: string; display_name: string | null; is_1099_eligible: boolean }>(
    supabase, 'vendors', 'id, name, display_name, is_1099_eligible', billsRaw.map((b) => b.vendor_id));

  const bills: Array<Record<string, any>> = billsRaw.map((b) => ({
    ...b,
    location: b.location_id ? locMap.get(b.location_id) ?? null : null,
    vendor: b.vendor_id ? venMap.get(b.vendor_id) ?? null : null,
  }));
  const billIds = bills.map((b) => b.id as string);

  // Which bills have job-tagged lines? (single query, no N+1)
  const jobLineCount: Record<string, number> = {};
  if (billIds.length > 0) {
    const { data: jl } = await supabase
      .from('bill_lines')
      .select('bill_id, job_id')
      .in('bill_id', billIds)
      .not('job_id', 'is', null);
    for (const row of jl ?? []) {
      const bid = (row as { bill_id: string }).bill_id;
      jobLineCount[bid] = (jobLineCount[bid] ?? 0) + 1;
    }
  }

  // Vendor compliance for returned bills
  const vendorIds = [...new Set(bills.map((b: any) => b.vendor?.id).filter(Boolean))] as string[];
  const complianceMap: Record<string, { missing: string[]; hasHold: boolean }> = {};

  if (vendorIds.length > 0) {
    const { data: docs } = await supabase
      .from('vendor_compliance_docs')
      .select('vendor_id, doc_type, expiration_date, status')
      .in('vendor_id', vendorIds);
    const { data: holds } = await supabase
      .from('vendor_payment_holds')
      .select('vendor_id')
      .in('vendor_id', vendorIds);
    const holdSet = new Set((holds ?? []).map((h: { vendor_id: string }) => h.vendor_id));

    for (const vid of vendorIds) {
      const vendorDocs = (docs ?? []).filter((d: any) => d.vendor_id === vid);
      const missing: string[] = [];
      const w9 = vendorDocs.find((d: any) => d.doc_type === 'W9');
      if (!w9 || w9.status !== 'CURRENT') missing.push('W-9');
      const glCoi = vendorDocs.find((d: any) => d.doc_type === 'GL_COI');
      if (glCoi && glCoi.expiration_date && new Date(glCoi.expiration_date) < new Date()) missing.push('GL COI (expired)');
      else if (!glCoi) missing.push('GL COI');
      const wcCoi = vendorDocs.find((d: any) => d.doc_type === 'WC_COI');
      if (wcCoi && wcCoi.expiration_date && new Date(wcCoi.expiration_date) < new Date()) missing.push('WC COI (expired)');
      if (missing.length > 0 || holdSet.has(vid)) complianceMap[vid] = { missing, hasHold: holdSet.has(vid) };
    }
  }

  const enrichedData = bills.map((bill: any) => {
    const vendorId = bill.vendor?.id;
    const compliance = vendorId ? complianceMap[vendorId] ?? null : null;
    const daysUntilDue = bill.due_date
      ? Math.ceil((new Date(bill.due_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
      : null;
    return { ...bill, compliance, daysUntilDue, jobLines: jobLineCount[bill.id] ?? 0 };
  });

  // Status counts
  const statusCounts: Record<string, { count: number; amount_cents: number }> = {};
  let totalCount = 0;
  let totalAmount = 0;
  for (const s of OPEN_STATUSES) {
    let q = supabase.from('bills').select('balance_cents').eq('org_id', orgId).eq('status', s);
    if (params.location_id) q = q.eq('location_id', params.location_id);
    const { data: rows } = await q;
    const cnt = (rows ?? []).length;
    const amt = (rows ?? []).reduce((sum: number, r: { balance_cents: number }) => sum + Math.abs(Number(r.balance_cents ?? 0)), 0);
    statusCounts[s] = { count: cnt, amount_cents: amt };
    totalCount += cnt;
    totalAmount += amt;
  }
  statusCounts['all'] = { count: totalCount, amount_cents: totalAmount };

  const homeCurrency = await getHomeCurrency(supabase, orgId);

  return NextResponse.json({
    data: enrichedData,
    counts: statusCounts,
    homeCurrency,
    pagination: { page, per_page: perPage, total: count ?? 0, total_pages: Math.ceil((count ?? 0) / perPage) },
  });
}
