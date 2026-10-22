import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { loadJob } from '@/lib/pm/guarded';
import { write } from '@/lib/pm/ops/rpc';
import { Cents, Day, Need, Qty, Text, Uuid } from '@/lib/pm/ops/schemas';

const Body = z.object({
  jobId: Uuid,
  description: Need(300, 'Describe the item'),
  vendorId: Uuid.nullish(),
  vendorSku: Text(80).nullish(),
  sidemark: Text(120).nullish(),
  qty: Qty.default(1),
  uom: Text(12).nullish(),
  unitCostCents: Cents.nullish(),
  markupPct: z.number().min(0).max(100).nullish(),
  unitSellCents: Cents.nullish(),
  freightCents: Cents.default(0),
  expectedOn: Day.nullish(),
  installOn: Day.nullish(),
  notes: Text(2000).nullish(),
});

/** A specified item (interior design FF&E or a flooring material order line). */
export const POST = route({ access: { cap: 'projects.selections', action: 'create' }, mask: 'procurement', body: Body }, async ({ db, body, tenant }) => {
  const job = await loadJob(db, body.jobId);
  assertCompany(tenant, job.location_id);
  const r = await write<Array<{ id: string }>>(
    db.schema('pm').from('procurement_items').insert({
      job_id: job.job_id, description: body.description, vendor_id: body.vendorId ?? null, vendor_sku: body.vendorSku || null, sidemark: body.sidemark || null,
      qty: body.qty, uom: body.uom || 'EA', unit_cost_cents: body.unitCostCents ?? null, markup_pct: body.markupPct ?? null,
      unit_sell_cents: body.unitSellCents ?? null, freight_cents: body.freightCents, expected_on: body.expectedOn ?? null,
      install_on: body.installOn ?? null, notes: body.notes || null,
    }).select('id'),
    'add item',
  );
  if (!r[0]) throw new HttpError(500, 'The item was not saved. Try again.', 'CREATE_FAILED');
  return { itemId: r[0].id };
});
