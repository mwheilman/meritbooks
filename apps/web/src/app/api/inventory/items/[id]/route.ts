export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';

/**
 * GET /api/inventory/items/[id] — one item with its movement history (RECEIPT /
 * ISSUE / ADJUST, newest first) and on-hand valuation. RLS-scoped; DEGRADE SAFE on
 * a missing table (404 instead of 500).
 */
function isMissingTable(err: { code?: string; message?: string } | null): boolean {
  return err?.code === '42P01' || /does not exist/i.test(err?.message ?? '');
}

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'fixed_assets', 'view');
  if (!guard.ok) return guard.response;

  const { data: item, error } = await supabase
    .from('inventory_items')
    .select(
      'id, sku, name, description, uom, valuation_method, qty_on_hand, avg_cost_cents, total_value_cents, reorder_point, is_active, location_id, asset_account_id, cogs_account_id, created_at',
    )
    .eq('id', params.id)
    .maybeSingle();

  if (error) {
    if (isMissingTable(error)) return NextResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 });
    return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
  }
  if (!item) return NextResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 });

  const { data: moves } = await supabase
    .from('inventory_movements')
    .select('id, movement_type, status, qty, unit_cost_cents, total_cost_cents, cogs_cents, reference, ref_type, memo, movement_date, gl_entry_id, posted_at, created_at')
    .eq('item_id', params.id)
    .order('movement_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(200);

  const movements = (moves ?? []).map((m: Record<string, unknown>) => ({
    id: m.id,
    type: m.movement_type,
    status: m.status,
    qty: Number(m.qty),
    unitCostCents: Number(m.unit_cost_cents ?? 0),
    totalCostCents: Number(m.total_cost_cents ?? 0),
    cogsCents: Number(m.cogs_cents ?? 0),
    reference: m.reference,
    refType: m.ref_type,
    memo: m.memo,
    movementDate: m.movement_date,
    glEntryId: m.gl_entry_id,
    postedAt: m.posted_at,
    createdAt: m.created_at,
  }));

  const it = item as Record<string, unknown>;
  return NextResponse.json({
    data: {
      id: it.id,
      sku: it.sku,
      name: it.name,
      description: it.description,
      uom: it.uom,
      valuationMethod: it.valuation_method,
      qtyOnHand: Number(it.qty_on_hand ?? 0),
      avgCostCents: Number(it.avg_cost_cents ?? 0),
      totalValueCents: Number(it.total_value_cents ?? 0),
      reorderPoint: it.reorder_point == null ? null : Number(it.reorder_point),
      isActive: it.is_active,
      locationId: it.location_id,
      assetAccountId: it.asset_account_id,
      cogsAccountId: it.cogs_account_id,
      createdAt: it.created_at,
      movements,
    },
  });
}
