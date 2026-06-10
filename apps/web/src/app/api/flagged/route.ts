export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { z } from 'zod';
import { fetchCoreMap } from '@/lib/stitch-core';

const flaggedQuerySchema = z.object({
  location_id: z.string().uuid().optional(),
  page: z.string().regex(/^\d+$/).optional(),
  per_page: z.string().regex(/^\d+$/).optional(),
});

interface FlaggedItem {
  id: string;
  type: 'bank_txn' | 'receipt' | 'bill';
  description: string;
  amountCents: number;
  reason: string | null;
  date: string;
  createdAt: string;
  locationCode: string | null;
  locationName: string | null;
}

/** Helper: Supabase FK joins return arrays. Extract first element safely. */
function fkFirst<T>(val: unknown): T | null {
  if (Array.isArray(val)) return (val[0] as T) ?? null;
  return (val as T) ?? null;
}

export const GET = apiQueryHandler(
  flaggedQuerySchema,
  async (params, ctx) => {
    const loc = params.location_id;

    let bankQ = ctx.supabase
      .from('bank_transactions')
      .select(`
        id, description, amount_cents, ai_reasoning, transaction_date, created_at, location_id
      `)
      .eq('status', 'FLAGGED')
      .order('created_at', { ascending: false })
      .limit(50);
    if (loc) bankQ = bankQ.eq('location_id', loc);

    let receiptQ = ctx.supabase
      .from('receipts')
      .select(`
        id, vendor_name, amount_cents, submitted_at, location_id
      `)
      .eq('status', 'FLAGGED')
      .order('submitted_at', { ascending: false })
      .limit(20);
    if (loc) receiptQ = receiptQ.eq('location_id', loc);

    let billQ = ctx.supabase
      .from('bills')
      .select(`
        id, bill_number, total_cents, payment_hold_reason, bill_date, created_at, vendor_id
      `)
      .eq('status', 'ON_HOLD')
      .order('created_at', { ascending: false })
      .limit(20);
    if (loc) billQ = billQ.eq('location_id', loc);

    const [bankResult, receiptResult, billResult] = await Promise.all([bankQ, receiptQ, billQ]);

    // Stitch core entities — cross-schema embeds don't work.
    const locIds = [
      ...(bankResult.data ?? []).map((t: any) => t.location_id),
      ...(receiptResult.data ?? []).map((r: any) => r.location_id),
    ];
    const locMap = await fetchCoreMap<{ id: string; name: string; short_code: string }>(
      ctx.supabase, 'locations', 'id, name, short_code', locIds);
    const venMap = await fetchCoreMap<{ id: string; name: string }>(
      ctx.supabase, 'vendors', 'id, name', (billResult.data ?? []).map((b: any) => b.vendor_id));

    const items: FlaggedItem[] = [];

    for (const t of bankResult.data ?? []) {
      const location = t.location_id ? locMap.get(t.location_id) ?? null : null;
      items.push({
        id: t.id,
        type: 'bank_txn',
        description: t.description,
        amountCents: Math.abs(Number(t.amount_cents)),
        reason: t.ai_reasoning,
        date: t.transaction_date,
        createdAt: t.created_at,
        locationCode: location?.short_code ?? null,
        locationName: location?.name ?? null,
      });
    }

    for (const r of receiptResult.data ?? []) {
      const location = r.location_id ? locMap.get(r.location_id) ?? null : null;
      items.push({
        id: r.id,
        type: 'receipt',
        description: r.vendor_name ?? 'Unknown receipt',
        amountCents: Math.abs(Number(r.amount_cents ?? 0)),
        reason: 'Flagged receipt — requires manual review',
        date: r.submitted_at?.split('T')[0] ?? '',
        createdAt: r.submitted_at,
        locationCode: location?.short_code ?? null,
        locationName: location?.name ?? null,
      });
    }

    for (const b of billResult.data ?? []) {
      const vendor = b.vendor_id ? venMap.get(b.vendor_id) ?? null : null;
      items.push({
        id: b.id,
        type: 'bill',
        description: `${vendor?.name ?? 'Unknown'} — ${b.bill_number ?? 'No #'}`,
        amountCents: Math.abs(Number(b.total_cents)),
        reason: b.payment_hold_reason ?? 'Payment hold — compliance issue',
        date: b.bill_date,
        createdAt: b.created_at,
        locationCode: null,
        locationName: null,
      });
    }

    items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return NextResponse.json({
      data: items,
      counts: {
        bank_txn: (bankResult.data ?? []).length,
        receipt: (receiptResult.data ?? []).length,
        bill: (billResult.data ?? []).length,
        total: items.length,
      },
    });
  }
);
