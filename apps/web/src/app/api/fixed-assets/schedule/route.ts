export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { buildDepreciationSchedule, mapBookMethod, isUnitsMethod, unitsOfProductionSchedule } from '@/lib/posting/depreciation-methods';

/**
 * GET /api/fixed-assets/schedule?assetId=...&method=STRAIGHT_LINE|DOUBLE_DECLINING|DECLINING_150|SUM_OF_YEARS_DIGITS|UNITS_OF_PRODUCTION
 *
 * Projects the pure per-period BOOK depreciation schedule for an asset, optionally
 * under a hypothetical method (so the UI can preview a method change before saving).
 * Same pure engine the poster uses — the projection and the posted amounts agree.
 * Units-of-production has no fixed time schedule, so its preview projects an
 * ILLUSTRATIVE even-usage curve across the useful life (labeled as such).
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
    .select('id, name, acquisition_date, acquisition_cost_cents, salvage_value_cents, useful_life_months, depreciation_method, total_expected_units, units_used')
    .eq('id', assetId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  const asset = data as {
    id: string; name: string; acquisition_date: string;
    acquisition_cost_cents: number; salvage_value_cents: number;
    useful_life_months: number; depreciation_method: string;
    total_expected_units: number | string | null; units_used: number | string | null;
  };
  const enumMethod = methodOverride || asset.depreciation_method;
  const start = new Date(`${asset.acquisition_date}T00:00:00Z`);
  const toPeriods = (schedule: number[]) => {
    let cumulative = 0;
    return schedule.map((amountCents, idx) => {
      cumulative += amountCents;
      const b = start.getUTCFullYear() * 12 + start.getUTCMonth() + idx;
      const year = Math.floor(b / 12);
      const month = (b % 12) + 1;
      return { index: idx + 1, period: `${year}-${String(month).padStart(2, '0')}`, amountCents, cumulativeCents: cumulative };
    });
  };

  // Units-of-production: no fixed time schedule. Project an illustrative even-usage
  // curve across the useful life so the UI can show the shape before saving.
  if (isUnitsMethod(enumMethod)) {
    const total = Number(asset.total_expected_units);
    if (!(total > 0)) {
      return NextResponse.json(
        { error: 'Set the total expected units to preview a units-of-production schedule.', code: 'NEEDS_UNITS' },
        { status: 422 }
      );
    }
    const life = asset.useful_life_months > 0 ? asset.useful_life_months : 1;
    const perPeriod = total / life;
    const unitsPerPeriod = Array.from({ length: life }, () => perPeriod);
    try {
      const schedule = unitsOfProductionSchedule(asset.acquisition_cost_cents, asset.salvage_value_cents, total, unitsPerPeriod);
      const periods = toPeriods(schedule);
      return NextResponse.json({
        ok: true,
        assetId: asset.id,
        method: enumMethod,
        basis: 'illustrative-even-usage',
        totalCents: periods.reduce((s, p) => s + p.amountCents, 0),
        periods,
      });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'schedule build failed' }, { status: 422 });
    }
  }

  const mapped = mapBookMethod(enumMethod);
  if (!mapped) {
    return NextResponse.json(
      { error: `Method ${enumMethod} is not book-postable here (MACRS_* uses the parallel tax engine).`, code: 'UNSUPPORTED_METHOD' },
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
    const periods = toPeriods(schedule);
    return NextResponse.json({
      ok: true,
      assetId: asset.id,
      method: enumMethod,
      totalCents: periods.reduce((s, p) => s + p.amountCents, 0),
      periods,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'schedule build failed' }, { status: 422 });
  }
}
