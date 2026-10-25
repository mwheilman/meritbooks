import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { can } from '@/lib/access/can';
import { pricebookOpTouchesCost } from '@/lib/fieldservice/cost-guard';
import { fsCall, fsWrite } from '@/lib/fieldservice/rpc';
import type { BulkPreview, PricebookImportReport } from '@/lib/fieldservice/types';
import { Text, Uuid } from '@/lib/pm/ops/schemas';

const ImportRowZ = z.object({
  code: z.string().trim().min(1).max(24),
  name: z.string().trim().min(1).max(200),
  kind: z.string().trim().max(12).optional(),
  category: z.string().trim().max(24).optional(),
  business_unit: z.string().trim().max(24).optional(),
  unit: z.string().trim().max(12).optional(),
  task_hours: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).optional(),
  cost_cents: z.string().regex(/^\d{1,12}$/).optional(),
  price_cents: z.string().regex(/^\d{1,12}$/).optional(),
  price_locked: z.boolean().optional(),
  target_gm_pct: z.string().regex(/^0?\.\d{1,4}$/).optional(),
  materials: z.string().max(500).optional(),
  customer_description: z.string().max(2000).optional(),
  active: z.boolean().optional(),
});

const Filter = z.object({
  categoryId: Uuid.nullish(),
  kind: z.enum(['SERVICE', 'MATERIAL', 'EQUIPMENT', 'FEE']).nullish(),
  businessUnitId: Uuid.nullish(),
  codes: z.array(z.string().max(24)).max(5000).nullish(),
}).default({});

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('reprice'), companyId: Uuid, itemIds: z.array(Uuid).max(5000).nullish() }),
  z.object({ op: z.literal('bulk'), companyId: Uuid, filter: Filter, mode: z.enum(['PCT', 'TARGET_GM', 'HOURS_PCT', 'REPRICE']), value: z.number().min(-0.9).max(5).nullish(), preview: z.boolean().default(true) }),
  z.object({ op: z.literal('import'), companyId: Uuid, rows: z.array(ImportRowZ).min(1).max(10_000), dryRun: z.boolean().default(true) }),
  z.object({ op: z.literal('seed'), companyId: Uuid, trades: z.array(z.enum(['HVAC', 'PLUMBING', 'ELECTRICAL'])).min(1).max(3) }),
  z.object({
    op: z.literal('settings'), companyId: Uuid,
    burdenedRateCents: z.number().int().min(0).max(10_000_000), targetGmPct: z.number().min(0).max(0.94), equipmentGmPct: z.number().min(0).max(0.94),
    memberDiscountPct: z.number().min(0).max(0.9), afterHoursMultiplier: z.number().min(1).max(5), rounding: z.enum(['NONE', 'WHOLE', 'FIVE', 'NINE']),
    priceFloorGmPct: z.number().min(0).max(0.94),
    tiers: z.array(z.object({ upToCents: z.number().int().positive().nullable(), markupPct: z.number().min(0).max(20) })).max(20),
  }),
  z.object({ op: z.literal('category'), companyId: Uuid, code: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/), name: Text(80).min(1), trade: z.enum(['HVAC', 'PLUMBING', 'ELECTRICAL', 'GENERAL', 'OTHER']).nullish() }),
]);

/**
 * Price-book maintenance (FS-44/45/46/47). Writes and previews run in definer RPCs that require
 * projects.settings:configure or projects.financials:edit at the company (the GM keeps the book);
 * the margin preview carries cost, so the response is masked as price-book money.
 */
export const POST = route({ access: { cap: 'projects.settings', action: 'view' }, mask: 'price_book', body: Body }, async ({ db, body, tenant, access }) => {
  assertCompany(tenant, body.companyId);
  const maintainer = can(access, 'projects.settings', 'configure', body.companyId) || can(access, 'projects.financials', 'edit', body.companyId);
  if (!maintainer) throw new HttpError(403, 'Keeping the price book needs Projects settings or job-financials edit at this company.', 'FORBIDDEN');
  // Margin targets are cost-equivalent: setting one and reading the resulting price reveals cost.
  if (pricebookOpTouchesCost(body) && !can(access, 'projects.financials', 'view', body.companyId)) {
    throw new HttpError(403, 'Costs and margin targets need job-financials access at this company.', 'FORBIDDEN');
  }
  const pm = db.schema('pm');
  switch (body.op) {
    case 'reprice': {
      const n = await fsCall<number>(db, 'fs_reprice_pricebook', { p_location: body.companyId, p_item_ids: body.itemIds ?? null });
      return { repriced: n };
    }
    case 'bulk': {
      if (body.mode !== 'REPRICE' && body.value == null) throw new HttpError(422, 'Enter the change.', 'VALIDATION');
      const filter = { category_id: body.filter.categoryId ?? null, kind: body.filter.kind ?? null, business_unit_id: body.filter.businessUnitId ?? null, codes: body.filter.codes ?? undefined };
      const r = await fsCall<BulkPreview>(db, 'fs_bulk_price_change', {
        p_location: body.companyId, p_filter: JSON.parse(JSON.stringify(filter)), p_change: { mode: body.mode, value: body.value ?? null }, p_preview: body.preview,
      });
      return { preview: { ...r, rows: r.rows.slice(0, 1000).map((x) => ({ ...x, location_id: body.companyId })) } };
    }
    case 'import': {
      const r = await fsCall<PricebookImportReport>(db, 'fs_import_pricebook', { p_location: body.companyId, p_rows: body.rows, p_dry_run: body.dryRun });
      return { report: r };
    }
    case 'seed': {
      const r = await fsCall<Record<string, number>>(db, 'fs_seed_field_service', { p_location: body.companyId, p_trades: body.trades });
      return { seeded: r };
    }
    case 'settings': {
      const row = {
        location_id: body.companyId, burdened_rate_cents: body.burdenedRateCents, target_gm_pct: body.targetGmPct, equipment_gm_pct: body.equipmentGmPct,
        member_discount_pct: body.memberDiscountPct, after_hours_multiplier: body.afterHoursMultiplier, rounding: body.rounding, price_floor_gm_pct: body.priceFloorGmPct,
      };
      await fsWrite(pm.from('pricebook_settings').upsert(row, { onConflict: 'org_id,location_id' }).select('id'), 'price-book settings');
      await fsWrite(pm.from('pricebook_markup_tiers').delete().eq('location_id', body.companyId).select('id'), 'markup ladder');
      if (body.tiers.length) {
        await fsWrite(pm.from('pricebook_markup_tiers').insert(body.tiers.map((t) => ({ location_id: body.companyId, up_to_cents: t.upToCents, markup_pct: t.markupPct }))).select('id'), 'markup ladder');
      }
      const n = await fsCall<number>(db, 'fs_reprice_pricebook', { p_location: body.companyId, p_item_ids: null });
      return { repriced: n };
    }
    case 'category': {
      await fsWrite(pm.from('pricebook_categories').insert({ location_id: body.companyId, code: body.code.toUpperCase(), name: body.name, trade: body.trade ?? null }).select('id'), 'add category');
      return { ok: true };
    }
  }
});
