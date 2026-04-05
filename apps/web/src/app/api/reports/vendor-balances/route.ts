export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';

export async function GET(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();
  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get('location_id');

  let query = supabase
    .from('bills')
    .select(`
      id, vendor_id, total_cents, amount_paid_cents, balance_cents, status, due_date,
      vendor:vendors!bills_vendor_id_fkey(id, name, is_1099_eligible)
    `)
    .not('status', 'eq', 'VOIDED');

  if (locationId) query = query.eq('location_id', locationId);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const vendorMap = new Map<string, {
    vendorId: string; vendorName: string; is1099: boolean;
    totalBilledCents: number; totalPaidCents: number; openBalanceCents: number;
    billCount: number; openBillCount: number;
    aging: Record<string, number>;
  }>();

  const now = new Date();
  for (const bill of data ?? []) {
    const v = Array.isArray(bill.vendor) ? bill.vendor[0] : bill.vendor;
    if (!v) continue;
    const key = v.id;
    const balance = Number(bill.balance_cents ?? 0);
    const daysOver = bill.due_date ? Math.max(0, Math.floor((now.getTime() - new Date(bill.due_date).getTime()) / 86400000)) : 0;
    const bucket = balance <= 0 ? 'PAID' : daysOver <= 0 ? 'CURRENT' : daysOver <= 30 ? '1-30' : daysOver <= 60 ? '31-60' : daysOver <= 90 ? '61-90' : '90+';

    const existing = vendorMap.get(key);
    if (existing) {
      existing.totalBilledCents += Number(bill.total_cents);
      existing.totalPaidCents += Number(bill.amount_paid_cents);
      existing.openBalanceCents += balance > 0 ? balance : 0;
      existing.billCount++;
      if (balance > 0) existing.openBillCount++;
      if (bucket !== 'PAID') existing.aging[bucket] = (existing.aging[bucket] ?? 0) + balance;
    } else {
      const aging: Record<string, number> = {};
      if (bucket !== 'PAID') aging[bucket] = balance;
      vendorMap.set(key, {
        vendorId: v.id, vendorName: v.name, is1099: v.is_1099_eligible,
        totalBilledCents: Number(bill.total_cents), totalPaidCents: Number(bill.amount_paid_cents),
        openBalanceCents: balance > 0 ? balance : 0, billCount: 1, openBillCount: balance > 0 ? 1 : 0, aging,
      });
    }
  }

  const vendors = Array.from(vendorMap.values()).sort((a, b) => b.openBalanceCents - a.openBalanceCents);

  return NextResponse.json({
    data: vendors,
    summary: {
      totalVendors: vendors.length,
      totalOpenCents: vendors.reduce((s, v) => s + v.openBalanceCents, 0),
      vendorsWithBalance: vendors.filter((v) => v.openBalanceCents > 0).length,
    },
  });
}
