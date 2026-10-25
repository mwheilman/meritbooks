export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { pm } from '@/lib/pm/db';
import { loadCatalog } from '@/lib/residential/queries';
import { resWrote } from '@/lib/residential/rpc';
import { Cents, CostTypeZ, Pct, Required, TaxCategoryZ, Text, Uuid } from '@/lib/residential/schemas';

export const GET = route({ access: { cap: 'projects.estimates', action: 'view' }, mask: 'estimate', query: z.object({ companyId: Uuid }) }, async ({ db, query }) =>
  loadCatalog(db, query.companyId));

const Item = z.object({
  op: z.literal('item'), companyId: Uuid, code: Required(60, 'Give it a code'), name: Required(200, 'Name it'), category: Text(80).nullish(),
  costCodeId: Uuid.nullish(), costType: CostTypeZ.default('MATERIALS'), uom: Text(12).default('EA'), unitCostCents: Cents.default(0),
  wastePct: z.number().min(0).max(2).default(0), markupPct: Pct.nullish(), marginPct: z.number().min(0).max(0.99).nullish(),
  unitPriceCents: Cents.nullish(), priceLocked: z.boolean().default(false), supplierSku: Text(80).nullish(), vendorId: Uuid.nullish(),
  supplierUrl: z.string().url().startsWith('http').nullish(), leadTimeDays: z.number().int().min(0).max(730).nullish(),
  laborRateCardId: Uuid.nullish(), laborHoursPerUnit: z.number().min(0).max(1000).nullish(), taxCategory: TaxCategoryZ.default('MATERIAL'),
});
const Assembly = z.object({
  op: z.literal('assembly'), companyId: Uuid, code: Required(60, 'Give it a code'), name: Required(200, 'Name it'), uom: Text(12).default('EA'),
  items: z.array(z.object({ catalogItemId: Uuid, qtyPerUnit: z.number().positive().max(1e6) })).min(1).max(100),
});

/** Catalog items and assemblies (cost code × cost type; sell follows markup unless the price is locked). */
export const POST = route({ access: { cap: 'projects.estimates', action: 'edit' }, mask: false, body: z.discriminatedUnion('op', [Item, Assembly]) }, async ({ db, body, tenant }) => {
  if (body.op === 'item') {
    if (body.markupPct != null && body.marginPct != null) throw new HttpError(422, 'Use a markup or a margin, not both.', 'VALIDATION');
    const r = resWrote<Array<{ id: string }>>(await pm(db).from('res_catalog_items').insert({
      org_id: tenant.orgId, location_id: body.companyId, code: body.code, name: body.name, category: body.category ?? null, cost_code_id: body.costCodeId ?? null,
      cost_type: body.costType, uom: body.uom, unit_cost_cents: body.unitCostCents, waste_pct: body.wastePct, markup_pct: body.markupPct ?? null,
      margin_pct: body.marginPct ?? null, unit_price_cents: body.unitPriceCents ?? null, price_locked: body.priceLocked, supplier_sku: body.supplierSku ?? null,
      vendor_id: body.vendorId ?? null, supplier_url: body.supplierUrl ?? null, lead_time_days: body.leadTimeDays ?? null,
      labor_rate_card_id: body.laborRateCardId ?? null, labor_hours_per_unit: body.laborHoursPerUnit ?? null, tax_category: body.taxCategory,
    }).select('id'));
    return { itemId: r[0]?.id ?? null };
  }
  const a = resWrote<Array<{ id: string }>>(await pm(db).from('res_assemblies').insert({ org_id: tenant.orgId, location_id: body.companyId, code: body.code, name: body.name, uom: body.uom }).select('id'));
  const id = a[0]!.id;
  resWrote(await pm(db).from('res_assembly_items').insert(body.items.map((x, i) => ({ org_id: tenant.orgId, assembly_id: id, catalog_item_id: x.catalogItemId, qty_per_unit: x.qtyPerUnit, sort: i + 1 }))).select('id'));
  return { assemblyId: id };
});
