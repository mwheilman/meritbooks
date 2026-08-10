export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import {
  buildStockValuationReport,
  type ValuationItemInput,
} from '@/lib/inventory/stock-valuation';
import type { ArInvoiceInput } from '@/lib/borrowing-base/calc';

/**
 * GET /api/borrowing-base — collateral inputs for the borrowing-base calculator.
 *
 * READ-ONLY. Returns the two collateral datasets the calculator advances against,
 * both scoped by RLS (tenant) and — when the header pins a company — by
 * `location_id` (a sub-filter within the tenant, per company-scope.ts):
 *   • Open AR, per invoice (from the SAME `v_ar_aging` view the AR-aging report
 *     uses), so the calculator can age against a caller-supplied cutoff.
 *   • On-hand inventory value at cost, via the SAME `buildStockValuationReport`
 *     engine the stock-valuation report uses (carried as bigint cents).
 *
 * The math (ineligibles, advance rates, concentration, availability) lives in the
 * pure `lib/borrowing-base/calc.ts` and runs CLIENT-SIDE so the lender inputs are
 * adjustable without a refetch. This route only supplies the raw figures.
 *
 * DEGRADE-SAFE: an absent inventory table returns zero inventory value, never a 500.
 */

function isMissingTable(err: { code?: string; message?: string } | null): boolean {
  return err?.code === '42P01' || /does not exist/i.test(err?.message ?? '');
}

interface ItemRow {
  id: string;
  sku: string;
  name: string;
  uom: string;
  valuation_method: 'WEIGHTED_AVG' | 'FIFO';
  qty_on_hand: number | string;
  avg_cost_cents: number | string;
  total_value_cents: number | string;
  location_id: string | null;
  is_active: boolean;
}

export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'reports', 'view');
  if (!guard.ok) return guard.response;

  const { searchParams } = new URL(request.url);
  const locationIds = searchParams.get('location_ids');
  const locationId = searchParams.get('location_id');
  const locFilter = locationIds
    ? locationIds.split(',').filter(Boolean)
    : locationId && locationId !== 'all'
      ? [locationId]
      : [];

  // ── Open AR, per invoice (v_ar_aging — excludes PAID/VOIDED/DRAFT/WRITTEN_OFF) ──
  let arQuery = supabase
    .from('v_ar_aging')
    .select('customer_id, customer_name, balance_cents, due_date, location_id')
    .gt('balance_cents', 0);
  if (locFilter.length === 1) arQuery = arQuery.eq('location_id', locFilter[0]);
  else if (locFilter.length > 1) arQuery = arQuery.in('location_id', locFilter);

  const { data: arData, error: arErr } = await arQuery;
  if (arErr && !isMissingTable(arErr)) {
    return NextResponse.json({ error: arErr.message, code: 'QUERY_ERROR' }, { status: 500 });
  }

  const arInvoices: ArInvoiceInput[] = (arData ?? []).map((r) => ({
    customerId: (r.customer_id as string) ?? '',
    customerName: (r.customer_name as string) ?? 'Unknown customer',
    balanceCents: Number(r.balance_cents ?? 0),
    dueDate: (r.due_date as string | null) ?? null,
  }));

  // ── On-hand inventory value (same engine as the stock-valuation report) ──────
  let inventoryValueCents = 0;
  let inventoryDegraded = false;
  let inventoryItemCount = 0;

  let invQuery = supabase
    .from('inventory_items')
    .select('id, sku, name, uom, valuation_method, qty_on_hand, avg_cost_cents, total_value_cents, location_id, is_active');
  if (locFilter.length === 1) invQuery = invQuery.eq('location_id', locFilter[0]);
  else if (locFilter.length > 1) invQuery = invQuery.in('location_id', locFilter);

  const { data: itemData, error: itemErr } = await invQuery;
  if (itemErr) {
    if (isMissingTable(itemErr)) {
      inventoryDegraded = true;
    } else {
      return NextResponse.json({ error: itemErr.message, code: 'QUERY_ERROR' }, { status: 500 });
    }
  } else {
    const rows = (itemData ?? []) as ItemRow[];
    const items: ValuationItemInput[] = rows.map((r) => ({
      id: r.id,
      sku: r.sku,
      name: r.name,
      uom: r.uom,
      valuationMethod: r.valuation_method,
      qtyOnHand: Number(r.qty_on_hand ?? 0),
      avgCostCents: Number(r.avg_cost_cents ?? 0),
      totalValueCents: Number(r.total_value_cents ?? 0),
      locationId: r.location_id,
      isActive: r.is_active,
    }));
    const report = buildStockValuationReport(items, { excludeZero: true });
    inventoryValueCents = report.summary.totalValueCents;
    inventoryItemCount = report.summary.itemsOnHand;
  }

  return NextResponse.json({
    arInvoices,
    inventoryValueCents,
    inventoryItemCount,
    inventoryDegraded,
    arInvoiceCount: arInvoices.length,
    asOf: new Date().toISOString().slice(0, 10),
    generatedAt: new Date().toISOString(),
  });
}
