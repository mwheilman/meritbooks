export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';

export async function GET(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();
  const { searchParams } = new URL(request.url);
  const locationIds = searchParams.get('location_ids');

  let query = supabase
    .from('equity_holders')
    .select(`
      id, holder_name, share_class, ownership_pct, invested_cents, distributions_ytd_cents,
      location:locations!equity_holders_location_id_fkey(id, name, short_code)
    `)
    .order('ownership_pct', { ascending: false });

  if (locationIds) {
    query = query.in('location_id', locationIds.split(','));
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const holders = (data ?? []).map((h) => {
    const loc = Array.isArray(h.location) ? h.location[0] : h.location;
    return {
      id: h.id,
      holderName: h.holder_name,
      shareClass: h.share_class,
      ownershipPct: Number(h.ownership_pct),
      investedCents: Number(h.invested_cents),
      distributionsYtdCents: Number(h.distributions_ytd_cents),
      netEquityCents: Number(h.invested_cents) - Number(h.distributions_ytd_cents),
      locationName: (loc as { name: string } | null)?.name ?? '',
      locationCode: (loc as { short_code: string } | null)?.short_code ?? '',
    };
  });

  const totalInvested = holders.reduce((s, h) => s + h.investedCents, 0);
  const totalDistributions = holders.reduce((s, h) => s + h.distributionsYtdCents, 0);

  return NextResponse.json({
    data: holders,
    summary: {
      holderCount: holders.length,
      totalInvestedCents: totalInvested,
      totalDistributionsCents: totalDistributions,
      netEquityCents: totalInvested - totalDistributions,
    },
  });
}
