export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { fetchCoreMap } from '@/lib/stitch-core';
import { requirePermission } from '@/lib/rbac/require-permission';
import { receiptListQuery } from '@/lib/validations/receipts';

interface ReceiptListDbRow {
  id: string;
  submitted_at: string;
  receipt_date: string | null;
  vendor_name: string | null;
  amount_cents: number | null;
  source: 'MOBILE_CAPTURE' | 'EMAIL' | 'MANUAL_UPLOAD';
  status: string;
  ai_confidence: number | null;
  chase_reminder_count: number;
  location_id: string;
  vendor_id: string | null;
  card_assignment_id: string | null;
  bank_transaction_id: string | null;
  match_status: 'unmatched' | 'suggested' | 'matched' | 'not_required';
  match_score: number | null;
  match_candidate_txn_id: string | null;
  match_method: string | null;
  extraction_status: string;
  memo: string | null;
  flags: string[] | null;
  account: { id: string; account_number: string; name: string } | Array<{ id: string; account_number: string; name: string }> | null;
}

/**
 * GET /api/receipts — the receipts inbox: every captured receipt with its read (AI or
 * rules), its match state (matched / suggested / unmatched), the charge it is matched or
 * suggested to, and the cardholder. receipts:view; RLS-scoped reads.
 */
export const GET = apiQueryHandler(receiptListQuery, async (params, ctx) => {
  const guard = await requirePermission(ctx.userId, 'receipts', 'view', { route: '/api/receipts' });
  if (!guard.ok) return guard.response;
  const page = parseInt(params.page ?? '1', 10);
  const perPage = Math.min(parseInt(params.per_page ?? '50', 10), 100);
  const offset = (page - 1) * perPage;

  let query = ctx.supabase
    .from('receipts')
    .select(
      `id, submitted_at, receipt_date, vendor_name, amount_cents, source, status, ai_confidence, chase_reminder_count,
       location_id, vendor_id, card_assignment_id, bank_transaction_id, match_status, match_score, match_candidate_txn_id,
       match_method, extraction_status, memo, flags,
       account:accounts!receipts_account_id_fkey(id, account_number, name)`,
      { count: 'exact' },
    );
  if (params.location_id) query = query.eq('location_id', params.location_id);
  if (params.status && params.status !== 'all') query = query.eq('status', params.status);
  else query = query.in('status', ['PENDING', 'CATEGORIZED', 'FLAGGED', 'APPROVED']);
  if (params.match && params.match !== 'all') query = query.eq('match_status', params.match);
  if (params.search && params.search.trim()) query = query.ilike('vendor_name', `%${params.search.trim().replace(/[%_]/g, '')}%`);
  query = query.order('submitted_at', { ascending: false }).range(offset, offset + perPage - 1);

  const { data, error, count } = await query;
  if (error) {
    console.error('[receipts] Query error:', error);
    return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
  }
  const rows = (data ?? []) as unknown as ReceiptListDbRow[];

  const locMap = await fetchCoreMap<{ id: string; name: string; short_code: string }>(ctx.supabase, 'locations', 'id, name, short_code', rows.map((r) => r.location_id));
  const venMap = await fetchCoreMap<{ id: string; name: string }>(ctx.supabase, 'vendors', 'id, name', rows.map((r) => r.vendor_id));

  const holderIds = Array.from(new Set(rows.map((r) => r.card_assignment_id).filter((x): x is string => !!x)));
  const holders = new Map<string, string>();
  if (holderIds.length) {
    const { data: hs } = await ctx.supabase.from('card_assignments').select('id, holder_name').in('id', holderIds);
    for (const h of (hs ?? []) as Array<{ id: string; holder_name: string }>) holders.set(h.id, h.holder_name);
  }
  const txnIds = Array.from(new Set(rows.flatMap((r) => [r.bank_transaction_id, r.match_candidate_txn_id]).filter((x): x is string => !!x)));
  const txns = new Map<string, { description: string; amount_cents: number; transaction_date: string }>();
  if (txnIds.length) {
    const { data: ts } = await ctx.supabase.from('bank_transactions').select('id, description, amount_cents, transaction_date').in('id', txnIds);
    for (const t of (ts ?? []) as Array<{ id: string; description: string; amount_cents: number; transaction_date: string }>) txns.set(t.id, t);
  }
  const chargeOf = (id: string | null) => {
    const t = id ? txns.get(id) : null;
    return t && id ? { id, description: t.description, amountCents: Math.abs(Number(t.amount_cents)), date: t.transaction_date } : null;
  };

  const stitched = rows.map((r) => ({
    id: r.id,
    submitted_at: r.submitted_at,
    receipt_date: r.receipt_date,
    vendor_name: r.vendor_name ?? (r.vendor_id ? venMap.get(r.vendor_id)?.name ?? null : null),
    amount_cents: r.amount_cents != null ? Number(r.amount_cents) : null,
    source: r.source,
    status: r.status,
    ai_confidence: r.ai_confidence != null ? Number(r.ai_confidence) : null,
    chase_reminder_count: r.chase_reminder_count,
    match_status: r.match_status,
    match_score: r.match_score != null ? Number(r.match_score) : null,
    match_method: r.match_method,
    extraction_status: r.extraction_status,
    memo: r.memo,
    flags: r.flags ?? [],
    location: locMap.get(r.location_id) ?? null,
    account: Array.isArray(r.account) ? r.account[0] ?? null : r.account,
    holder_name: r.card_assignment_id ? holders.get(r.card_assignment_id) ?? null : null,
    matched_charge: chargeOf(r.bank_transaction_id),
    suggested_charge: r.match_status === 'suggested' ? chargeOf(r.match_candidate_txn_id) : null,
  }));

  // Counts by match state for the tabs (respecting the company filter).
  const counts: Record<string, number> = {};
  for (const m of ['unmatched', 'suggested', 'matched'] as const) {
    let q = ctx.supabase.from('receipts').select('id', { count: 'exact', head: true }).eq('match_status', m).in('status', ['PENDING', 'CATEGORIZED', 'FLAGGED', 'APPROVED']);
    if (params.location_id) q = q.eq('location_id', params.location_id);
    const { count: c } = await q;
    counts[m] = c ?? 0;
  }
  counts.all = counts.unmatched + counts.suggested + counts.matched;

  return NextResponse.json({
    data: stitched,
    counts,
    pagination: { page, per_page: perPage, total: count ?? 0, total_pages: Math.ceil((count ?? 0) / perPage) },
  });
});
