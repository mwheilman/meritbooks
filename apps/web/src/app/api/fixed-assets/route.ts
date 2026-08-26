export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { fetchCoreMap } from '@/lib/stitch-core';

/** Depreciation methods the enum accepts (migration 001 + 079). The book methods
 *  post to the GL; MACRS_* drive the parallel tax track. */
const DEPRECIATION_METHODS = [
  'STRAIGHT_LINE', 'DOUBLE_DECLINING', 'DECLINING_150', 'SUM_OF_YEARS_DIGITS', 'UNITS_OF_PRODUCTION',
  'MACRS_3', 'MACRS_5', 'MACRS_7', 'MACRS_10', 'MACRS_15', 'MACRS_20',
] as const;

export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

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
      total_expected_units, units_used,
      accumulated_depreciation_cents, net_book_value_cents,
      last_depreciation_date, status,
      disposal_date, disposal_proceeds_cents,
      physical_location, condition, barcode, last_inspection_date,
      location_id, assigned_to,
      asset_account:accounts!fixed_assets_asset_account_id_fkey(account_number, name),
      depreciation_account:accounts!fixed_assets_depreciation_expense_account_id_fkey(account_number, name),
      accum_dep_account:accounts!fixed_assets_accumulated_depreciation_account_id_fkey(account_number, name)
    `)
    .eq('org_id', orgId)
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

  // `assigned_to` FKs core.employees. PostgREST cannot embed across the core↔public
  // schema boundary (PGRST200), so — exactly like `location` above — stitch the
  // employee in via a batched core lookup instead of a `!fk(...)` embed.
  const empMap = await fetchCoreMap<{ id: string; first_name: string; last_name: string }>(
    supabase, 'employees', 'id, first_name, last_name', rows.map((r) => r.assigned_to));
  for (const r of rows) r.assigned_to_employee = r.assigned_to ? empMap.get(r.assigned_to) ?? null : null;

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
    totalExpectedUnits: a.total_expected_units == null ? null : Number(a.total_expected_units),
    unitsUsed: Number(a.units_used ?? 0),
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
 * PATCH /api/fixed-assets
 *   { id, depreciationMethod?, usefulLifeMonths?, salvageValueCents?, totalExpectedUnits?, unitsUsed? }
 *
 * Adjust an asset's depreciation basis. Basis fields (method / life / salvage /
 * total expected units) may only change BEFORE depreciation has started
 * (accumulated = 0) — a mid-life re-basis would need an explicit prospective
 * recompute, which we refuse to do silently. `unitsUsed` is the units-of-
 * production USAGE METER (not a basis input): it accrues over the asset's life, so
 * it may be updated any time before disposal — the next depreciation run charges
 * the incremental usage. RLS-scoped write (createServerSupabase).
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

  // Basis fields (locked after depreciation begins) vs the usage meter (always OK).
  const update: Record<string, unknown> = {};
  let basisChanged = false;
  if (body.depreciationMethod !== undefined) {
    const m = String(body.depreciationMethod);
    if (!(DEPRECIATION_METHODS as readonly string[]).includes(m)) {
      return NextResponse.json({ error: `depreciationMethod must be one of: ${DEPRECIATION_METHODS.join(', ')}` }, { status: 422 });
    }
    update.depreciation_method = m;
    basisChanged = true;
  }
  if (body.usefulLifeMonths !== undefined) {
    const n = Number(body.usefulLifeMonths);
    if (!Number.isInteger(n) || n <= 0) return NextResponse.json({ error: 'usefulLifeMonths must be a positive integer' }, { status: 422 });
    update.useful_life_months = n;
    basisChanged = true;
  }
  if (body.salvageValueCents !== undefined) {
    const n = Number(body.salvageValueCents);
    if (!Number.isInteger(n) || n < 0) return NextResponse.json({ error: 'salvageValueCents must be a non-negative integer' }, { status: 422 });
    update.salvage_value_cents = n;
    basisChanged = true;
  }
  if (body.totalExpectedUnits !== undefined) {
    if (body.totalExpectedUnits === null) {
      update.total_expected_units = null;
    } else {
      const n = Number(body.totalExpectedUnits);
      if (!Number.isFinite(n) || n <= 0) return NextResponse.json({ error: 'totalExpectedUnits must be a positive number' }, { status: 422 });
      update.total_expected_units = n;
    }
    basisChanged = true;
  }
  if (body.unitsUsed !== undefined) {
    const n = Number(body.unitsUsed);
    if (!Number.isFinite(n) || n < 0) return NextResponse.json({ error: 'unitsUsed must be a non-negative number' }, { status: 422 });
    update.units_used = n; // usage meter — not a basis change
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
  if (basisChanged && Number(row.accumulated_depreciation_cents) > 0) {
    return NextResponse.json(
      { error: 'Depreciation basis can only change before depreciation begins (accumulated must be 0). The units-used meter can still be updated.' },
      { status: 422 }
    );
  }

  update.updated_at = new Date().toISOString();
  const { error: updErr } = await supabase.from('fixed_assets').update(update).eq('id', id);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, id, updated: update });
}
