export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { buildDepreciationSchedule, mapBookMethod } from '@/lib/posting/depreciation-methods';

/**
 * GET /api/fixed-assets/schedule?assetId=...&method=STRAIGHT_LINE|DOUBLE_DECLINING
 *
 * Projects the pure per-period BOOK depreciation schedule for an asset, optionally
 * under a hypothetical method (so the UI can preview a method change before saving).
 * Same pure engine the poster uses — the projection and the posted amounts agree.
 */
export async function GET(request: Request) {
  await auth().catch(() => null);
  const { searchParams } = new URL(request.url);
  const assetId = searchParams.get('assetId');
  const methodOverride = searchParams.get('method');
  if (!assetId) return NextResponse.json({ error: 'assetId is required' }, { status: 422 });

  const supabase = await createServerSupabase();
  const { data, error } = await supabase
    .from('fixed_assets')
    .select('id, name, acquisition_date, acquisition_cost_cents, salvage_value_cents, useful_life_months, depreciation_method')
    .eq('id', assetId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  const asset = data as {
    id: string; name: string; acquisition_date: string;
    acquisition_cost_cents: number; salvage_value_cents: number;
    useful_life_months: number; depreciation_method: string;
  };
  const enumMethod = methodOverride || asset.depreciation_method;
  const mapped = mapBookMethod(enumMethod);
  if (!mapped) {
    return NextResponse.json(
      { error: `Method ${enumMethod} is not book-postable here (MACRS_* uses the tax engine; SYD / 150%-DB / units-of-production need a new enum value).`, code: 'UNSUPPORTED_METHOD' },
      { status: 422 }
    );
  }

  try {
    const schedule = buildDepreciationSchedule({
      costCents: asset.acquisition_cost_cents,
      salvageCents: asset.salvage_value_cents,
      usefulLifeMonths: asset.useful_life_months,
      method: mapped.method,
      decliningFactor: mapped.decliningFactor,
    });
    const start = new Date(`${asset.acquisition_date}T00:00:00Z`);
    let cumulative = 0;
    const periods = schedule.map((amountCents, idx) => {
      cumulative += amountCents;
      const base = start.getUTCFullYear() * 12 + start.getUTCMonth() + idx;
      const year = Math.floor(base / 12);
      const month = (base % 12) + 1;
      return { index: idx + 1, period: `${year}-${String(month).padStart(2, '0')}`, amountCents, cumulativeCents: cumulative };
    });
    return NextResponse.json({
      ok: true,
      assetId: asset.id,
      method: enumMethod,
      totalCents: cumulative,
      periods,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'schedule build failed' }, { status: 422 });
  }
}
