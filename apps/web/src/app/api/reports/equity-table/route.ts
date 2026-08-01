export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { fetchCoreMap } from '@/lib/stitch-core';

export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase } = ctx;
  const { searchParams } = new URL(request.url);
  const locationIds = searchParams.get('location_ids');

  let query = supabase
    .from('equity_holders')
    .select(`
      id, holder_name, share_class, ownership_pct, invested_cents, distributions_ytd_cents,
      location_id
    `)
    .order('ownership_pct', { ascending: false });

  if (locationIds) {
    query = query.in('location_id', locationIds.split(','));
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as Array<Record<string, any>>;
  const locMap = await fetchCoreMap<{ id: string; name: string; short_code: string }>(
    supabase, 'locations', 'id, name, short_code', rows.map((r) => r.location_id));
  const holders = rows.map((h) => {
    const loc = h.location_id ? locMap.get(h.location_id) ?? null : null;
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
