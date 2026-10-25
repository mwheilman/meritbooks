export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { xcall, xrows } from '@/lib/dealer/rpc';
import { IsoDate, PosCents, Req, Text, Uuid } from '@/lib/dealer/schemas';

export interface RollRow {
  id: string;
  product_id: string;
  roll_number: string;
  dye_lot: string;
  width_in: number;
  original_len_in: number;
  remaining_len_in: number;
  bin: string | null;
  status: 'AVAILABLE' | 'RESERVED' | 'REMNANT' | 'DEPLETED' | 'DAMAGED';
  reserved_job_id: string | null;
  parent_roll_id: string | null;
  cost_per_lf_cents: number | null;
  received_on: string;
  received_condition: string;
}

const Q = z.object({ company: Uuid, status: z.enum(['AVAILABLE', 'RESERVED', 'REMNANT', 'DEPLETED', 'DAMAGED', 'ALL']).default('ALL') });

/** Roll and remnant stock by product and dye lot (cost per LF is masked to financials). */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: 'part', query: Q }, async ({ db, query, tenant }) => {
  assertCompany(tenant, query.company);
  const pm = db.schema('pm');
  let q = pm.from('v_flr_rolls_masked').select('id, product_id, roll_number, dye_lot, width_in, original_len_in, remaining_len_in, bin, status, reserved_job_id, parent_roll_id, cost_per_lf_cents, received_on, received_condition').eq('location_id', query.company);
  if (query.status !== 'ALL') q = q.eq('status', query.status); else q = q.neq('status', 'DEPLETED');
  const [rolls, products] = await Promise.all([
    xrows<RollRow>(q.order('received_on', { ascending: false }).limit(1000), 'rolls'),
    xrows<{ id: string; sku: string; style: string; color: string | null; category: string; roll_width_ft: number | null }>(pm.from('v_flr_products_masked').select('id, sku, style, color, category, roll_width_ft').eq('location_id', query.company).eq('is_active', true).order('style'), 'products'),
  ]);
  return { rolls: rolls.map((r) => ({ ...r, width_in: Number(r.width_in), original_len_in: Number(r.original_len_in), remaining_len_in: Number(r.remaining_len_in) })), products };
});

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('receive'), companyId: Uuid, productId: Uuid, rollNumber: Req(40, 'The roll number'), dyeLot: Req(40, 'The dye lot'), widthIn: z.number().positive().max(240), lengthIn: z.number().positive().max(100_000), stockLocationId: Uuid.nullish(), bin: Text(40).nullish(), costPerLfCents: PosCents.nullish(), procurementItemId: Uuid.nullish(), condition: z.enum(['GOOD', 'DAMAGED', 'SHORT']).default('GOOD'), notes: Text(500).nullish() }),
  z.object({ op: z.literal('suggest'), companyId: Uuid, productId: Uuid, lengthIn: z.number().positive().max(100_000), jobId: Uuid.nullish() }),
  z.object({ op: z.literal('record_cut'), cutId: Uuid, actualLenIn: z.number().positive().max(100_000).nullish() }),
]);

/** Receive a roll, ask which roll to cut from (same lot first, remnants before full rolls), record a cut (remnant / scrap by the company's rule). */
export const POST = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: 'part', body: Op }, async ({ db, body, tenant }) => {
  switch (body.op) {
    case 'receive':
      assertCompany(tenant, body.companyId);
      return { id: await xcall<string>(db, 'flr_receive_roll', { p_location: body.companyId, p_product: body.productId, p_roll_number: body.rollNumber, p_dye_lot: body.dyeLot, p_width_in: body.widthIn, p_length_in: body.lengthIn, p_stock_location: body.stockLocationId ?? null, p_bin: body.bin ?? null, p_cost_per_lf_cents: body.costPerLfCents ?? null, p_procurement_item: body.procurementItemId ?? null, p_condition: body.condition, p_notes: body.notes ?? null }) };
    case 'suggest':
      assertCompany(tenant, body.companyId);
      return xcall(db, 'flr_suggest_roll', { p_location: body.companyId, p_product: body.productId, p_length_in: body.lengthIn, p_job: body.jobId ?? null });
    case 'record_cut':
      return xcall(db, 'flr_record_cut', { p_cut: body.cutId, p_actual_len_in: body.actualLenIn ?? null });
  }
});
