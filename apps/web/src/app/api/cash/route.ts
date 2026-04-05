export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';

export async function GET(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();
  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get('location_id');

  let query = supabase.from('v_cash_position').select('*');
  if (locationId) query = query.eq('location_id', locationId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Group by location
  const locationMap = new Map<string, {
    locationId: string;
    locationName: string;
    minimumCashCents: number;
    accounts: { id: string; name: string; mask: string; type: string; balanceCents: number; availableCents: number; status: string; updatedAt: string | null }[];
    totalCashCents: number;
    cashStatus: string;
  }>();

  for (const row of data ?? []) {
    const key = row.location_id;
    const existing = locationMap.get(key);
    const account = {
      id: row.bank_account_id,
      name: row.account_name ?? row.institution_name ?? 'Unknown',
      mask: row.account_mask ?? '',
      type: row.account_type ?? 'CHECKING',
      balanceCents: Number(row.current_balance_cents ?? 0),
      availableCents: Number(row.available_balance_cents ?? 0),
      status: row.cash_status ?? 'ADEQUATE',
      updatedAt: row.balance_updated_at,
    };

    if (existing) {
      existing.accounts.push(account);
      existing.totalCashCents += account.balanceCents;
    } else {
      locationMap.set(key, {
        locationId: key,
        locationName: row.location_name,
        minimumCashCents: Number(row.minimum_cash_cents ?? 0),
        accounts: [account],
        totalCashCents: account.balanceCents,
        cashStatus: row.cash_status ?? 'ADEQUATE',
      });
    }
  }

  const locations = Array.from(locationMap.values()).sort((a, b) => a.locationName.localeCompare(b.locationName));
  const totalCash = locations.reduce((s, l) => s + l.totalCashCents, 0);
  const criticalCount = locations.filter((l) => l.cashStatus === 'CRITICAL').length;
  const nearMinCount = locations.filter((l) => l.cashStatus === 'NEAR_MINIMUM').length;
  const totalAccounts = locations.reduce((s, l) => s + l.accounts.length, 0);

  return NextResponse.json({
    locations,
    summary: { totalCashCents: totalCash, entityCount: locations.length, accountCount: totalAccounts, criticalCount, nearMinCount },
  });
}
