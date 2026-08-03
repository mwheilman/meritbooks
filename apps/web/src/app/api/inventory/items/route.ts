export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { logHumanAction } from '@/lib/trust/action-log';

/**
 * Inventory items (GATE 11c). GET lists items with on-hand + valuation rollups and
 * a summary; POST creates an item. DEGRADE SAFE: if the tables are absent (migration
 * not yet applied) GET returns an empty set rather than 500. RLS-scoped.
 *
 * RBAC: gated on 'fixed_assets' until a dedicated 'inventory' feature is added to the
 * (reserved) permission catalog — REPORTED to the lead.
 */

/** Postgres "relation does not exist" — the module degrades to an empty state. */
function isMissingTable(err: { code?: string; message?: string } | null): boolean {
  return err?.code === '42P01' || /does not exist/i.test(err?.message ?? '');
}

export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'fixed_assets', 'view');
  if (!guard.ok) return guard.response;

  const { data, error } = await supabase
    .from('inventory_items')
    .select(
      'id, sku, name, description, uom, valuation_method, qty_on_hand, avg_cost_cents, total_value_cents, reorder_point, is_active, location_id, created_at',
    )
    .order('name');

  if (error) {
    if (isMissingTable(error)) {
      return NextResponse.json({ data: [], summary: emptySummary(), degraded: true });
    }
    return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
  }

  const items = (data ?? []).map((r: Record<string, unknown>) => ({
    id: r.id,
    sku: r.sku,
    name: r.name,
    description: r.description,
    uom: r.uom,
    valuationMethod: r.valuation_method,
    qtyOnHand: Number(r.qty_on_hand ?? 0),
    avgCostCents: Number(r.avg_cost_cents ?? 0),
    totalValueCents: Number(r.total_value_cents ?? 0),
    reorderPoint: r.reorder_point == null ? null : Number(r.reorder_point),
    isActive: r.is_active,
    locationId: r.location_id,
    createdAt: r.created_at,
  }));

  const totalValueCents = items.reduce((s, i) => s + i.totalValueCents, 0);
  const belowReorder = items.filter(
    (i) => i.reorderPoint != null && i.qtyOnHand <= (i.reorderPoint as number),
  ).length;

  return NextResponse.json({
    data: items,
    summary: {
      count: items.length,
      activeCount: items.filter((i) => i.isActive).length,
      totalValueCents,
      belowReorderCount: belowReorder,
    },
  });
}

function emptySummary() {
  return { count: 0, activeCount: 0, totalValueCents: 0, belowReorderCount: 0 };
}

const createSchema = z.object({
  sku: z.string().min(1).max(80),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  uom: z.string().min(1).max(20).default('each'),
  valuation_method: z.enum(['WEIGHTED_AVG', 'FIFO']).default('WEIGHTED_AVG'),
  location_id: z.string().uuid().optional(),
  asset_account_id: z.string().uuid().optional(),
  cogs_account_id: z.string().uuid().optional(),
  reorder_point: z.number().nonnegative().optional(),
});

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'fixed_assets', 'create');
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) {
    const details: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.') || '_root';
      (details[path] ??= []).push(issue.message);
    }
    return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details }, { status: 422 });
  }
  const body = parsed.data;

  const { data, error } = await supabase
    .from('inventory_items')
    .insert({
      org_id: orgId,
      sku: body.sku,
      name: body.name,
      description: body.description ?? null,
      uom: body.uom,
      valuation_method: body.valuation_method,
      location_id: body.location_id ?? null,
      asset_account_id: body.asset_account_id ?? null,
      cogs_account_id: body.cogs_account_id ?? null,
      reorder_point: body.reorder_point ?? null,
      qty_on_hand: 0,
      avg_cost_cents: 0,
      total_value_cents: 0,
      fifo_layers: [],
      is_active: true,
      created_by: null,
    })
    .select('id')
    .single();

  if (error) {
    if (isMissingTable(error)) {
      return NextResponse.json(
        { error: 'Inventory is not enabled yet (schema pending).', code: 'NOT_ENABLED' },
        { status: 503 },
      );
    }
    if (error.code === '23505') {
      return NextResponse.json({ error: 'An item with that SKU already exists.', code: 'DUPLICATE_SKU' }, { status: 409 });
    }
    return NextResponse.json({ error: error.message, code: 'INSERT_ERROR' }, { status: 500 });
  }

  await logHumanAction(supabase, userId, orgId, {
    action: 'inventory_item.create',
    subjectTable: 'inventory_items',
    subjectId: data.id as string,
    summary: `Created inventory item ${body.sku} — ${body.name}`,
  });

  return NextResponse.json({ id: data.id }, { status: 201 });
}
