export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';

export async function GET(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();
  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get('location_id');

  let query = supabase.from('v_ap_aging').select('*');
  if (locationId) query = query.eq('location_id', locationId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const buckets: Record<string, { count: number; totalCents: number }> = {
    CURRENT: { count: 0, totalCents: 0 }, '1-30': { count: 0, totalCents: 0 },
    '31-60': { count: 0, totalCents: 0 }, '61-90': { count: 0, totalCents: 0 },
    '90+': { count: 0, totalCents: 0 },
  };
  for (const row of data ?? []) {
    const b = row.aging_bucket as string;
    if (buckets[b]) { buckets[b].count++; buckets[b].totalCents += Number(row.balance_cents ?? 0); }
  }

  return NextResponse.json({
    data: (data ?? []).map((r) => ({
      vendorName: r.vendor_name, billNumber: r.bill_number, billDate: r.bill_date,
      dueDate: r.due_date, totalCents: Number(r.total_cents ?? 0),
      paidCents: Number(r.amount_paid_cents ?? 0), balanceCents: Number(r.balance_cents ?? 0),
      agingBucket: r.aging_bucket, locationName: r.location_name,
    })),
    buckets,
    totalOutstanding: Object.values(buckets).reduce((s, b) => s + b.totalCents, 0),
  });
}
