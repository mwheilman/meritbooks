export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';

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
      location:locations!fixed_assets_location_id_fkey(id, name, short_code),
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

  const assets = (data ?? []).map((a: Record<string, unknown>) => ({
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
