export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { dwrite } from '@/lib/pm/dealer/rpc';
import { xrows } from '@/lib/dealer/rpc';
import { FLOOR_CATEGORIES } from '@/lib/flooring/measure-import';
import { CompanyOnlyQ, IsoDate, Pct, PosCents, Req, Text, Uuid } from '@/lib/dealer/schemas';

/** The flooring catalog: products (landed cost masked), labor codes (installer pay masked) and crew capacity. */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: ['part', 'labor_rate'], query: CompanyOnlyQ }, async ({ db, query, tenant }) => {
  assertCompany(tenant, query.company);
  const pm = db.schema('pm');
  const [products, labor, capacity] = await Promise.all([
    xrows<Record<string, unknown>>(pm.from('v_flr_products_masked').select('id, sku, style, color, mill_name, vendor_id, category, sell_uom, roll_width_ft, carton_sf, waste_pct, cost_cents, price_retail_cents, price_builder_cents, price_contract_cents, taxable, is_active').eq('location_id', query.company).order('category').order('style'), 'products'),
    xrows<Record<string, unknown>>(pm.from('v_flr_labor_rates_masked').select('id, code, description, unit, applies_to, categories, sell_cents, pay_cents, job_minimum_pay_cents, is_active').eq('location_id', query.company).order('code'), 'labor codes'),
    xrows<Record<string, unknown>>(pm.from('flr_capacity').select('id, crew_id, weekday, on_date, sf_per_day, jobs_per_day').eq('location_id', query.company).order('weekday', { nullsFirst: true }), 'capacity'),
  ]);
  return { products, labor, capacity };
});

const Product = z.object({
  sku: Text(60).nullish(), style: Req(120, 'The style'), color: Text(80).nullish(), millName: Text(120).nullish(), vendorId: Uuid.nullish(),
  category: z.enum(FLOOR_CATEGORIES), sellUom: z.enum(['SY', 'SF', 'CARTON', 'LF', 'EA', 'ROLL']), rollWidthFt: z.number().positive().max(30).nullish(),
  cartonSf: z.number().positive().max(1000).nullish(), wastePct: Pct.nullish(), costCents: PosCents.nullish(), priceRetailCents: PosCents.nullish(),
  priceBuilderCents: PosCents.nullish(), priceContractCents: PosCents.nullish(), taxable: z.boolean().default(true),
});
const Labor = z.object({
  code: z.string().regex(/^[A-Z0-9_]{2,32}$/, 'Codes are 2–32 capitals, digits or _'), description: Req(160, 'The description'),
  unit: z.enum(['SY', 'SF', 'LF', 'STEP', 'EA', 'JOB', 'HOUR']), appliesTo: z.enum(['FLOOR', 'STAIRS', 'PERIMETER', 'TRANSITION', 'PREP', 'DEMO', 'MOVING', 'OTHER']),
  categories: z.array(z.enum(FLOOR_CATEGORIES)).max(11).default([]), sellCents: PosCents, payCents: PosCents, jobMinimumPayCents: PosCents.default(0),
});
const Capacity = z.object({ crewId: Uuid.nullish(), weekday: z.number().int().min(1).max(7).nullish(), onDate: IsoDate.nullish(), sfPerDay: z.number().min(0).max(1e6), jobsPerDay: z.number().int().min(0).max(50).nullish() });

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_product'), companyId: Uuid, product: Product }),
  z.object({ op: z.literal('add_labor'), companyId: Uuid, labor: Labor }),
  z.object({ op: z.literal('set_capacity'), companyId: Uuid, capacity: Capacity }),
  z.object({ op: z.literal('retire'), kind: z.enum(['product', 'labor']), id: Uuid }),
]);

export const POST = route({
  access: { cap: 'projects.estimates', action: 'edit' },
  ops: { add_labor: { cap: 'projects.labor_rates', action: 'edit' }, set_capacity: { cap: 'projects.dispatch', action: 'edit' } },
  mask: ['part', 'labor_rate'],
  body: Op,
}, async ({ db, body, tenant }) => {
  const pm = db.schema('pm');
  switch (body.op) {
    case 'add_product': {
      assertCompany(tenant, body.companyId);
      const p = body.product;
      if ((p.sellUom === 'SY' || p.sellUom === 'ROLL') && !p.rollWidthFt) throw new HttpError(422, 'Broadloom sold by the yard or roll needs a roll width.', 'VALIDATION');
      if (p.sellUom === 'CARTON' && !p.cartonSf) throw new HttpError(422, 'A product sold by the carton needs square feet per carton.', 'VALIDATION');
      const r = await dwrite<Array<{ id: string }>>(pm.from('flr_products').insert({
        location_id: body.companyId, sku: p.sku ?? null, style: p.style, color: p.color ?? null, mill_name: p.millName ?? null, vendor_id: p.vendorId ?? null,
        category: p.category, sell_uom: p.sellUom, roll_width_ft: p.rollWidthFt ?? null, carton_sf: p.cartonSf ?? null, waste_pct: p.wastePct ?? null,
        cost_cents: p.costCents ?? null, price_retail_cents: p.priceRetailCents ?? null, price_builder_cents: p.priceBuilderCents ?? null, price_contract_cents: p.priceContractCents ?? null, taxable: p.taxable,
      }).select('id'), 'add product');
      return { id: r[0]?.id ?? null };
    }
    case 'add_labor': {
      assertCompany(tenant, body.companyId);
      const l = body.labor;
      const r = await dwrite<Array<{ id: string }>>(pm.from('flr_labor_rates').insert({ location_id: body.companyId, code: l.code, description: l.description, unit: l.unit, applies_to: l.appliesTo, categories: l.categories, sell_cents: l.sellCents, pay_cents: l.payCents, job_minimum_pay_cents: l.jobMinimumPayCents }).select('id'), 'add labor code');
      return { id: r[0]?.id ?? null };
    }
    case 'set_capacity': {
      assertCompany(tenant, body.companyId);
      const c = body.capacity;
      const r = await dwrite<Array<{ id: string }>>(pm.from('flr_capacity').insert({ location_id: body.companyId, crew_id: c.crewId ?? null, weekday: c.weekday ?? null, on_date: c.onDate ?? null, sf_per_day: c.sfPerDay, jobs_per_day: c.jobsPerDay ?? null }).select('id'), 'set capacity');
      return { id: r[0]?.id ?? null };
    }
    case 'retire':
      await dwrite(pm.from(body.kind === 'product' ? 'flr_products' : 'flr_labor_rates').update({ is_active: false }).eq('id', body.id).select('id'), 'retire');
      return { ok: true };
  }
});
