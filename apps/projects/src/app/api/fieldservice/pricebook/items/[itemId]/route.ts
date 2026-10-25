import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { can } from '@/lib/access/can';
import { fsCall, fsOwn, fsWrite } from '@/lib/fieldservice/rpc';
import { Cents, Text, Uuid } from '@/lib/pm/ops/schemas';

const Body = z.object({
  name: Text(200).min(1).optional(),
  kind: z.enum(['SERVICE', 'MATERIAL', 'EQUIPMENT', 'FEE']).optional(),
  categoryId: Uuid.nullish(),
  businessUnitId: Uuid.nullish(),
  taskHours: z.number().min(0).max(999).nullish(),
  costCents: Cents.nullish(),
  priceCents: Cents.optional(),
  priceLocked: z.boolean().optional(),
  targetGmPct: z.number().min(0).max(0.94).nullish(),
  gbbTier: z.enum(['GOOD', 'BETTER', 'BEST']).nullish(),
  customerDescription: Text(2000).nullish(),
  isActive: z.boolean().optional(),
  materials: z.array(z.object({ itemId: Uuid, qty: z.number().positive().max(100000) })).max(50).optional(),
});

/** Edit one item, then reprice it (and every service that bundles it). */
export const PATCH = route({ access: { cap: 'projects.settings', action: 'view' }, mask: 'price_book', body: Body }, async ({ db, params, body, tenant, access }) => {
  const it = await fsOwn<{ id: string; location_id: string; kind: string }>(db, 'v_price_book_items_masked', 'id, location_id, kind', params.itemId!, 'That item was not found.');
  assertCompany(tenant, it.location_id);
  if (!(can(access, 'projects.settings', 'configure', it.location_id) || can(access, 'projects.financials', 'edit', it.location_id))) {
    throw new HttpError(403, 'Keeping the price book needs Projects settings or job-financials edit at this company.', 'FORBIDDEN');
  }
  if ((body.targetGmPct !== undefined || body.costCents !== undefined) && !can(access, 'projects.financials', 'view', it.location_id)) {
    throw new HttpError(403, 'Costs and margin targets need job-financials access at this company.', 'FORBIDDEN');
  }
  const pm = db.schema('pm');
  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.kind !== undefined) patch.kind = body.kind;
  if (body.categoryId !== undefined) patch.category_id = body.categoryId;
  if (body.businessUnitId !== undefined) patch.business_unit_id = body.businessUnitId;
  if (body.taskHours !== undefined) patch.task_hours = body.taskHours;
  if (body.costCents !== undefined) patch.cost_cents = body.costCents;
  if (body.priceCents !== undefined) patch.price_cents = body.priceCents;
  if (body.priceLocked !== undefined) patch.price_locked = body.priceLocked;
  if (body.targetGmPct !== undefined) patch.target_gm_pct = body.targetGmPct;
  if (body.gbbTier !== undefined) patch.gbb_tier = body.gbbTier;
  if (body.customerDescription !== undefined) patch.customer_description = body.customerDescription || null;
  if (body.isActive !== undefined) patch.is_active = body.isActive;
  if (Object.keys(patch).length) await fsWrite(pm.from('price_book_items').update(patch).eq('id', it.id).select('id'), 'update item');
  if (body.materials) {
    await fsWrite(pm.from('pricebook_service_materials').delete().eq('service_item_id', it.id).select('id'), 'bundled materials');
    if (body.materials.length) {
      await fsWrite(pm.from('pricebook_service_materials').insert(body.materials.map((m) => ({ service_item_id: it.id, material_item_id: m.itemId, qty: m.qty }))).select('id'), 'bundled materials');
    }
  }
  await fsCall(db, 'fs_reprice_pricebook', { p_location: it.location_id, p_item_ids: [it.id] });
  const row = await pm.from('v_price_book_items_masked').select('id, location_id, price_cents, member_price_cents, after_hours_price_cents, cost_cents').eq('id', it.id).maybeSingle();
  return { item: row.data };
});
