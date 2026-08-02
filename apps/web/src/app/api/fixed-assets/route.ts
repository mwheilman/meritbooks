export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase, createServerSupabase } from '@/lib/supabase/server';
import { fetchCoreMap } from '@/lib/stitch-core';

/** Book depreciation methods the enum accepts (packages/supabase migration 001). */
const DEPRECIATION_METHODS = [
  'STRAIGHT_LINE', 'DOUBLE_DECLINING',
  'MACRS_3', 'MACRS_5', 'MACRS_7', 'MACRS_10', 'MACRS_15', 'MACRS_20',
] as const;

export async function GET(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();
  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get('location_id');
  const status = searchParams.get('status');
  const category = searchParams.get('category');

  let query = supabase
    .from('fixed_assets')
    .select(`
      id, asset_tag, name, description, serial_number, category,
      acquisition_date, acquisition_cost_cents, salvage_value_cents,
      useful_life_months, depreciation_method,
      accumulated_depreciation_cents, net_book_value_cents,
      last_depreciation_date, status,
      disposal_date, disposal_proceeds_cents,
      physical_location, condition, barcode, last_inspection_date,
      location_id,
      assigned_to_employee:employees!fixed_assets_assigned_to_fkey(id, first_name, last_name),
      asset_account:accounts!fixed_assets_asset_account_id_fkey(account_number, name),
      depreciation_account:accounts!fixed_assets_depreciation_expense_account_id_fkey(account_number, name),
      accum_dep_account:accounts!fixed_assets_accumulated_depreciation_account_id_fkey(account_number, name)
    `)
    .order('name');

  if (locationId) query = query.eq('location_id', locationId);
  if (status) query = query.eq('status', status);
  if (category) query = query.eq('category', category);

  const { data, error } = await query;

  if (error) {
    console.error('[fixed-assets] Query error:', error);
    return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
  }

  const rows = (data ?? []) as Array<Record<string, any>>;
  const locMap = await fetchCoreMap<{ id: string; name: string; short_code: string }>(
    supabase, 'locations', 'id, name, short_code', rows.map((r) => r.location_id));
  for (const r of rows) r.location = r.location_id ? locMap.get(r.location_id) ?? null : null;

  const assets = rows.map((a: Record<string, unknown>) => ({
    id: a.id,
    assetTag: a.asset_tag,
    name: a.name,
    description: a.description,
    serialNumber: a.serial_number,
    category: a.category,
    acquisitionDate: a.acquisition_date,
    acquisitionCostCents: a.acquisition_cost_cents,
    salvageValueCents: a.salvage_value_cents,
    usefulLifeMonths: a.useful_life_months,
    depreciationMethod: a.depreciation_method,
    accumulatedDepreciationCents: a.accumulated_depreciation_cents,
    netBookValueCents: a.net_book_value_cents,
    lastDepreciationDate: a.last_depreciation_date,
    status: a.status,
    disposalDate: a.disposal_date,
    disposalProceedsCents: a.disposal_proceeds_cents,
    physicalLocation: a.physical_location,
    condition: a.condition,
    barcode: a.barcode,
    lastInspectionDate: a.last_inspection_date,
    location: a.location,
    assignedTo: a.assigned_to_employee,
    assetAccount: a.asset_account,
    depreciationAccount: a.depreciation_account,
    accumDepAccount: a.accum_dep_account,
  }));

  const totalCost = assets.reduce((s: number, a: Record<string, unknown>) => s + Number(a.acquisitionCostCents ?? 0), 0);
  const totalNBV = assets.reduce((s: number, a: Record<string, unknown>) => s + Number(a.netBookValueCents ?? 0), 0);
  const totalAccumDep = assets.reduce((s: number, a: Record<string, unknown>) => s + Number(a.accumulatedDepreciationCents ?? 0), 0);
  const byStatus: Record<string, number> = {};
  for (const a of assets) { const st = a.status as string; byStatus[st] = (byStatus[st] ?? 0) + 1; }

  return NextResponse.json({
    data: assets,
    summary: { count: assets.length, totalCostCents: totalCost, totalNBVCents: totalNBV, totalAccumDepCents: totalAccumDep, byStatus },
  });
}

/**
 * PATCH /api/fixed-assets  { id, depreciationMethod?, usefulLifeMonths?, salvageValueCents? }
 *
 * Adjust an asset's depreciation basis. Method / life / salvage may only change
 * BEFORE depreciation has started (accumulated = 0) — a mid-life re-basis would
 * need an explicit prospective recompute, which we refuse to do silently.
 * RLS-scoped write (createServerSupabase).
 */
export async function PATCH(request: Request) {
  await auth().catch(() => null);
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const id = typeof body.id === 'string' ? body.id : null;
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 422 });

  const update: Record<string, unknown> = {};
  if (body.depreciationMethod !== undefined) {
    const m = String(body.depreciationMethod);
    if (!(DEPRECIATION_METHODS as readonly string[]).includes(m)) {
      return NextResponse.json({ error: `depreciationMethod must be one of: ${DEPRECIATION_METHODS.join(', ')}` }, { status: 422 });
    }
    update.depreciation_method = m;
  }
  if (body.usefulLifeMonths !== undefined) {
    const n = Number(body.usefulLifeMonths);
    if (!Number.isInteger(n) || n <= 0) return NextResponse.json({ error: 'usefulLifeMonths must be a positive integer' }, { status: 422 });
    update.useful_life_months = n;
  }
  if (body.salvageValueCents !== undefined) {
    const n = Number(body.salvageValueCents);
    if (!Number.isInteger(n) || n < 0) return NextResponse.json({ error: 'salvageValueCents must be a non-negative integer' }, { status: 422 });
    update.salvage_value_cents = n;
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 422 });
  }

  const supabase = await createServerSupabase();
  const { data: asset, error: readErr } = await supabase
    .from('fixed_assets')
    .select('id, status, accumulated_depreciation_cents')
    .eq('id', id)
    .maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  const row = asset as { id: string; status: string; accumulated_depreciation_cents: number };
  if (row.status === 'DISPOSED') {
    return NextResponse.json({ error: 'Cannot modify a disposed asset' }, { status: 422 });
  }
  if (Number(row.accumulated_depreciation_cents) > 0) {
    return NextResponse.json(
      { error: 'Depreciation basis can only change before depreciation begins (accumulated must be 0)' },
      { status: 422 }
    );
  }

  update.updated_at = new Date().toISOString();
  const { error: updErr } = await supabase.from('fixed_assets').update(update).eq('id', id);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, id, updated: update });
}
