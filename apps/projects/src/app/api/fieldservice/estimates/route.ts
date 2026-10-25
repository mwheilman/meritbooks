import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { fsCall, fsOwn } from '@/lib/fieldservice/rpc';
import { Cents, Text, Uuid } from '@/lib/pm/ops/schemas';

const Item = z.object({
  priceBookItemId: Uuid.nullish(),
  description: Text(300).nullish(),
  unitPriceCents: Cents.nullish(),
  qty: z.number().positive().max(100000).default(1),
  optional: z.boolean().default(false),
  selected: z.boolean().optional(),
}).refine((i) => !!i.priceBookItemId || (!!i.description && i.unitPriceCents != null), { message: 'Pick a price-book item or type a line with a price' });

const Option = z.object({
  tier: z.enum(['GOOD', 'BETTER', 'BEST', 'OPTION']).default('OPTION'),
  name: Text(120).min(1),
  description: Text(2000).nullish(),
  rebateCents: Cents.default(0),
  rebateNote: Text(200).nullish(),
  financingPlanId: Uuid.nullish(),
  recommended: z.boolean().default(false),
  items: z.array(Item).min(1).max(40),
});

const Body = z.object({
  workOrderId: Uuid,
  title: Text(160).nullish(),
  memberPricing: z.boolean().nullish(),
  options: z.array(Option).min(1).max(5),
});

/**
 * Good / better / best (FS-32/52): the tech dispatched on the visit (or a dispatcher / estimator)
 * builds 1–5 options from the price book. Prices are pinned from the book at build time.
 */
export const POST = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, body: Body }, async ({ db, body, tenant }) => {
  const wo = await fsOwn<{ id: string; location_id: string }>(db, 'work_orders', 'id, location_id', body.workOrderId, 'That visit was not found.');
  assertCompany(tenant, wo.location_id);
  const options = body.options.map((o) => ({
    tier: o.tier, name: o.name, description: o.description ?? null, rebate_cents: o.rebateCents, rebate_note: o.rebateNote ?? null,
    financing_plan_id: o.financingPlanId ?? null, recommended: o.recommended,
    items: o.items.map((i) => ({
      price_book_item_id: i.priceBookItemId ?? null, description: i.description ?? null, unit_price_cents: i.unitPriceCents ?? null,
      qty: i.qty, optional: i.optional, selected: i.selected ?? !i.optional,
    })),
  }));
  const id = await fsCall<string>(db, 'fs_build_estimate', { p_wo: wo.id, p_title: body.title || null, p_options: options, p_member_pricing: body.memberPricing ?? null });
  return { estimateId: id };
});
