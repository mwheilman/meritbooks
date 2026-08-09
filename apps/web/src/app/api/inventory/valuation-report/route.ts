export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { resolveRole, PostingError } from '@/lib/posting/account-roles';
import {
  buildStockValuationReport,
  computeGlTieOut,
  type ValuationItemInput,
} from '@/lib/inventory/stock-valuation';

/**
 * GET /api/inventory/valuation-report — the stock-valuation report.
 *
 * Returns every on-hand inventory item valued at its current on-hand cost, grouped
 * by location, with subtotals, a valuation-method breakdown, and a GL tie-out: the
 * subledger on-hand value reconciled against the GL Inventory Asset control account
 * balance (a variance is an informational reconciling item — receipts are
 * valuation-only in this build, so the bill books the GL asset). Also surfaces
 * period-to-date realized COGS from posted ISSUE/ADJUST movements.
 *
 * Query params:
 *   include_zero=1        keep items with zero on-hand and zero value
 *   as_of / cogs_from     YYYY-MM-DD — bound realized-COGS to a period (optional)
 *
 * RLS-scoped. DEGRADE SAFE: an absent inventory table returns an empty report,
 * never a 500. RBAC gated on 'fixed_assets:view' (interim, until a dedicated
 * 'inventory' permission — REPORTED to the lead, mirrors the other inventory routes).
 */

function isMissingTable(err: { code?: string; message?: string } | null): boolean {
  return err?.code === '42P01' || /does not exist/i.test(err?.message ?? '');
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  asset_account_id: string | null;
  is_active: boolean;
}

const ITEM_COLUMNS =
  'id, sku, name, uom, valuation_method, qty_on_hand, avg_cost_cents, total_value_cents, location_id, asset_account_id, is_active';

function emptyReport() {
  return {
    report: { groups: [], summary: { itemCount: 0, itemsOnHand: 0, totalValueCents: 0, byMethod: [] } },
    tieOut: { subledgerCents: 0, glCents: 0, varianceCents: 0, inSync: true, resolvable: false },
    cogs: { realizedCents: 0, movementCount: 0, from: null, to: null },
    generatedAt: new Date().toISOString(),
  };
}

export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'fixed_assets', 'view');
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const includeZero = url.searchParams.get('include_zero') === '1';
  const cogsFrom = url.searchParams.get('cogs_from');
  const cogsTo = url.searchParams.get('as_of') ?? url.searchParams.get('cogs_to');

  // --- Items -----------------------------------------------------------------
  const { data: itemData, error: itemErr } = await supabase
    .from('inventory_items')
    .select(ITEM_COLUMNS)
    .order('name');

  if (itemErr) {
    if (isMissingTable(itemErr)) return NextResponse.json({ ...emptyReport(), degraded: true });
    return NextResponse.json({ error: itemErr.message, code: 'QUERY_ERROR' }, { status: 500 });
  }

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

  // --- Location names --------------------------------------------------------
  const locationIds = Array.from(new Set(rows.map((r) => r.location_id).filter((x): x is string => !!x)));
  const locationNames: Record<string, string> = {};
  if (locationIds.length > 0) {
    const { data: locs } = await supabase
      .schema('core')
      .from('locations')
      .select('id, name')
      .in('id', locationIds);
    for (const l of (locs ?? []) as { id: string; name: string }[]) locationNames[l.id] = l.name;
  }

  const report = buildStockValuationReport(items, { locationNames, excludeZero: !includeZero });

  // --- GL tie-out: subledger on-hand value vs GL Inventory Asset balance ------
  // The set of GL asset accounts inventory can land in: the item-level overrides
  // plus the role-default INVENTORY_ASSET account.
  const assetAccountIds = new Set<string>();
  for (const r of rows) if (r.asset_account_id) assetAccountIds.add(r.asset_account_id);
  try {
    const role = await resolveRole(supabase, orgId, 'INVENTORY_ASSET');
    assetAccountIds.add(role.id);
  } catch (e) {
    if (!(e instanceof PostingError)) throw e;
    // No inventory asset account in this tenant's COA — fall back to item overrides.
  }
  const resolvable = assetAccountIds.size > 0;

  let glCents = 0;
  if (resolvable) {
    const { data: glLines, error: glErr } = await supabase
      .from('gl_entry_lines')
      .select('debit_cents, credit_cents, gl_entries!inner(status)')
      .in('account_id', Array.from(assetAccountIds))
      .eq('gl_entries.status', 'POSTED');
    if (glErr && !isMissingTable(glErr)) {
      return NextResponse.json({ error: glErr.message, code: 'QUERY_ERROR' }, { status: 500 });
    }
    for (const l of (glLines ?? []) as { debit_cents: number | string; credit_cents: number | string }[]) {
      glCents += Number(l.debit_cents ?? 0) - Number(l.credit_cents ?? 0); // ASSET is debit-normal
    }
  }

  const tie = computeGlTieOut(report.summary.totalValueCents, glCents);

  // --- Realized COGS (posted ISSUE / ADJUST movements) -----------------------
  let cogsQuery = supabase
    .from('inventory_movements')
    .select('cogs_cents, movement_date')
    .eq('status', 'POSTED')
    .in('movement_type', ['ISSUE', 'ADJUST']);
  if (cogsFrom && DATE_RE.test(cogsFrom)) cogsQuery = cogsQuery.gte('movement_date', cogsFrom);
  if (cogsTo && DATE_RE.test(cogsTo)) cogsQuery = cogsQuery.lte('movement_date', cogsTo);
  const { data: cogsRows } = await cogsQuery;
  const realizedCents = (cogsRows ?? []).reduce(
    (s: number, m: { cogs_cents: number | string }) => s + Number(m.cogs_cents ?? 0),
    0,
  );

  return NextResponse.json({
    report,
    tieOut: { ...tie, resolvable },
    cogs: {
      realizedCents,
      movementCount: (cogsRows ?? []).length,
      from: cogsFrom && DATE_RE.test(cogsFrom) ? cogsFrom : null,
      to: cogsTo && DATE_RE.test(cogsTo) ? cogsTo : null,
    },
    generatedAt: new Date().toISOString(),
  });
}
