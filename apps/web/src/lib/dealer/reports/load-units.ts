/**
 * Loaders for R3 Unit aging and R4 Unit gross (RLS reads only).
 */

import { loadSettings } from '@/lib/dealer/service/settings';
import type { DeptRole } from '@/lib/dealer/types';
import type { DealerReport } from './catalog';
import { buildUnitAging, buildUnitGross } from './build-units';
import { all, allIn, ids, num, str, vendorNames, type ReportCtx } from './load-shared';

const INVENTORY_ROLES = new Set(['WHOLE_GOODS_INVENTORY', 'USED_WHOLE_GOODS_INVENTORY', 'RENTAL_INVENTORY']);

export async function loadUnitAging(d: ReportCtx, asOf: string, entityLabel: string): Promise<DealerReport> {
  const [settings, rows] = await Promise.all([
    loadSettings(d),
    all(
      'Unit aging',
      () =>
        d.db
          .from('v_unit_aging')
          .select('unit_id, serial_number, stock_number, make_vendor_id, model, model_year, condition, status, is_consignment, cost_cents, received_date, principal_balance_cents, maturity_date, is_floored')
          .eq('org_id', d.orgId)
          .eq('location_id', d.locationId),
      'unit_id',
    ),
  ]);
  const makeNames = await vendorNames(d, ids(rows, 'make_vendor_id'));
  return buildUnitAging({
    asOf,
    entityLabel,
    edges: settings.aging_buckets,
    makeNames,
    units: rows.map((r) => ({
      unit_id: r.unit_id as string,
      serial_number: String(r.serial_number ?? ''),
      stock_number: str(r.stock_number),
      make_vendor_id: str(r.make_vendor_id),
      model: str(r.model),
      model_year: r.model_year == null ? null : num(r.model_year),
      condition: String(r.condition ?? 'NEW'),
      status: String(r.status ?? 'IN_STOCK'),
      is_consignment: r.is_consignment === true,
      cost_cents: num(r.cost_cents),
      received_date: str(r.received_date),
      principal_balance_cents: r.principal_balance_cents == null ? null : num(r.principal_balance_cents),
      maturity_date: str(r.maturity_date),
      is_floored: r.is_floored === true,
    })),
  });
}

export async function loadUnitGross(d: ReportCtx, start: string, end: string, entityLabel: string): Promise<DealerReport> {
  const sales = await all('Unit sales', () =>
    d.db
      .from('dealer_unit_sales')
      .select('id, unit_id, sale_date, sale_price_cents, cogs_cents, salesperson, trade_in_id, gl_entry_id, external_deal_ref')
      .eq('org_id', d.orgId)
      .eq('location_id', d.locationId)
      .eq('status', 'POSTED')
      .gte('sale_date', start)
      .lte('sale_date', end),
  );
  const unitIds = ids(sales, 'unit_id');
  const saleIds = ids(sales, 'id');
  const [units, trades, incByUnit, incBySale] = await Promise.all([
    allIn('Units', unitIds, (chunk) => d.db.from('dealer_units').select('id, serial_number, make_vendor_id, department_role, model').eq('org_id', d.orgId).in('id', chunk)),
    allIn('Trade-ins', ids(sales, 'trade_in_id'), (chunk) => d.db.from('trade_ins').select('id, over_allowance_cents').eq('org_id', d.orgId).in('id', chunk)),
    allIn('Unit incentives', unitIds, (chunk) =>
      d.db.from('oem_incentive_claims').select('id, unit_id, sale_id, accrued_cents, written_off_cents, accrual_target_role, status').eq('org_id', d.orgId).eq('treatment', 'COST_REDUCTION').in('unit_id', chunk).neq('status', 'VOID'),
    ),
    allIn('Deal incentives', saleIds, (chunk) =>
      d.db.from('oem_incentive_claims').select('id, unit_id, sale_id, accrued_cents, written_off_cents, accrual_target_role, status').eq('org_id', d.orgId).eq('treatment', 'COST_REDUCTION').in('sale_id', chunk).neq('status', 'VOID'),
    ),
  ]);
  const incentives = new Map<string, { unit_id: string | null; sale_id: string | null; amount_cents: number }>();
  for (const i of [...incByUnit, ...incBySale]) {
    // A cost-reduction booked against the unit's inventory is already inside its cost of sale.
    if (INVENTORY_ROLES.has(String(i.accrual_target_role ?? ''))) continue;
    const saleId = str(i.sale_id);
    incentives.set(i.id as string, {
      unit_id: str(i.unit_id),
      sale_id: saleId && saleIds.includes(saleId) ? saleId : null,
      amount_cents: Math.max(0, num(i.accrued_cents) - num(i.written_off_cents)),
    });
  }
  const unitMap = new Map(
    units.map((u) => [u.id as string, { serial_number: String(u.serial_number ?? ''), make_vendor_id: str(u.make_vendor_id), department_role: (u.department_role as DeptRole) ?? 'WG_NEW', model: str(u.model) }]),
  );
  const makeNames = await vendorNames(d, ids(units, 'make_vendor_id'));
  return buildUnitGross({
    start,
    end,
    entityLabel,
    sales: sales.map((s) => ({
      id: s.id as string,
      unit_id: s.unit_id as string,
      sale_date: String(s.sale_date),
      sale_price_cents: num(s.sale_price_cents),
      cogs_cents: s.cogs_cents == null ? null : num(s.cogs_cents),
      salesperson: str(s.salesperson),
      trade_in_id: str(s.trade_in_id),
      gl_entry_id: str(s.gl_entry_id),
      external_deal_ref: str(s.external_deal_ref),
    })),
    units: unitMap,
    makeNames,
    overAllowance: new Map(trades.map((t) => [t.id as string, num(t.over_allowance_cents)])),
    incentives: [...incentives.values()],
  });
}
