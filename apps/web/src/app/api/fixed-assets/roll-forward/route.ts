export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createServerSupabase } from '@/lib/supabase/server';
import {
  computeRollForward,
  type RollForwardAsset,
  type RollForwardRun,
} from '@/lib/posting/fixed-asset-rollforward';

/**
 * GET /api/fixed-assets/roll-forward?periodStart=YYYY-MM-DD&periodEnd=YYYY-MM-DD&location_id=
 *
 * The fixed-asset continuity schedule per class + total: beginning balances,
 * additions, disposals, depreciation, ending net book value. Period-scoped and
 * RLS-scoped (createServerSupabase). Cost movements come from the asset register;
 * accumulated-depreciation movements are reconstructed from posted BOOK runs, so
 * the schedule ties to the GL.
 */
export async function GET(request: Request) {
  await auth().catch(() => null);
  const { searchParams } = new URL(request.url);

  const now = new Date();
  const defaultStart = `${now.getUTCFullYear()}-01-01`;
  const defaultEnd = `${now.getUTCFullYear()}-12-31`;
  const periodStart = searchParams.get('periodStart') || defaultStart;
  const periodEnd = searchParams.get('periodEnd') || defaultEnd;
  const locationId = searchParams.get('location_id');

  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(periodStart) || !dateRe.test(periodEnd)) {
    return NextResponse.json({ error: 'periodStart/periodEnd must be YYYY-MM-DD' }, { status: 422 });
  }
  if (periodEnd < periodStart) {
    return NextResponse.json({ error: 'periodEnd must be on or after periodStart' }, { status: 422 });
  }

  const supabase = await createServerSupabase();
  try {
    let assetQuery = supabase
      .from('fixed_assets')
      .select('id, category, acquisition_date, acquisition_cost_cents, disposal_date, location_id');
    if (locationId) assetQuery = assetQuery.eq('location_id', locationId);
    const { data: assetRows, error: assetErr } = await assetQuery;
    if (assetErr) return NextResponse.json({ error: assetErr.message, code: 'QUERY_ERROR' }, { status: 500 });

    const assets: RollForwardAsset[] = (assetRows ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as string,
      category: (r.category as string | null) ?? null,
      acquisitionDate: r.acquisition_date as string,
      acquisitionCostCents: Number(r.acquisition_cost_cents ?? 0),
      disposalDate: (r.disposal_date as string | null) ?? null,
    }));

    const assetIds = assets.map((a) => a.id);
    let runs: RollForwardRun[] = [];
    if (assetIds.length > 0) {
      const { data: runRows, error: runErr } = await supabase
        .from('depreciation_runs')
        .select('fixed_asset_id, period_year, period_month, amount_cents')
        .in('fixed_asset_id', assetIds);
      if (runErr) return NextResponse.json({ error: runErr.message, code: 'QUERY_ERROR' }, { status: 500 });
      runs = (runRows ?? []).map((r: Record<string, unknown>) => ({
        fixedAssetId: r.fixed_asset_id as string,
        periodYear: Number(r.period_year),
        periodMonth: Number(r.period_month),
        amountCents: Number(r.amount_cents ?? 0),
      }));
    }

    const result = computeRollForward(assets, runs, periodStart, periodEnd);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'roll-forward failed' }, { status: 500 });
  }
}
