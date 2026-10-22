export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { rows } from '@/lib/pm/db';
import { customerNames } from '@/lib/pm/ops/scope';
import { dcall, downs, dwrite } from '@/lib/pm/dealer/rpc';
import { Day, RoPayTypeZ, Text, Uuid, attrs } from '@/lib/pm/dealer/schemas';
import { RO_LINE_COLS, type RoLineRow } from '@/lib/pm/dealer/types';

const Money = z.number().int().min(0).max(1e11);
const Kind = z.enum(['LABOR', 'PART', 'SUBLET', 'MISC']);

const Op = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add_line'),
    kind: Kind,
    payType: RoPayTypeZ.default('CUSTOMER'),
    description: Text(300).nullish(),
    laborOp: Text(40).nullish(),
    flagHours: z.number().min(0).max(1000).nullish(),
    qty: z.number().positive().max(1e8).default(1),
    unitPriceCents: Money.nullish(),
    unitCostCents: Money.nullish(),
    partId: Uuid.nullish(),
    stockLocationId: Uuid.nullish(),
  }),
  z.object({
    op: z.literal('update_line'),
    lineId: Uuid,
    payType: RoPayTypeZ.optional(),
    description: Text(300).optional(),
    laborOp: Text(40).nullish(),
    flagHours: z.number().min(0).max(1000).nullish(),
    qty: z.number().positive().max(1e8).optional(),
    unitPriceCents: Money.nullish(),
    unitCostCents: Money.nullish(),
  }),
  z.object({ op: z.literal('remove_line'), lineId: Uuid }),
  z.object({
    op: z.literal('claim'),
    payerCustomerId: Uuid.nullish(),
    oemVendorId: Uuid.nullish(),
    claimNumber: Text(60).nullish(),
    failureCode: Text(60).nullish(),
    laborOp: Text(40).nullish(),
    filingDeadline: Day.nullish(),
  }),
]);

interface Wo { id: string; job_id: string; location_id: string; number: string | null; kind: string; status: string; payer_customer_id: string | null; asset_id: string | null }

/** The RO line editor's data: lines with labor op, part and pay type, the payer, claims on the RO. */
export const GET = route({ access: { cap: 'projects.store', action: 'view' }, mask: 'repair_order' }, async ({ db, params }) => {
  const wo = await downs<Wo>(db, 'work_orders', 'id, job_id, location_id, number, kind, status, payer_customer_id, asset_id', params.woId!, 'That repair order was not found.');
  const pm = db.schema('pm');
  const lines = rows<RoLineRow>(await pm.from('v_work_order_lines_masked').select(RO_LINE_COLS).eq('work_order_id', wo.id).order('sort').order('created_at'), 'lines')
    .map((l) => ({ ...l, qty: Number(l.qty), unit_price_cents: l.unit_price_cents == null ? null : Number(l.unit_price_cents), unit_cost_cents: l.unit_cost_cents == null ? null : Number(l.unit_cost_cents), amount_cents: Number(l.amount_cents), flag_hours: l.flag_hours == null ? null : Number(l.flag_hours), discount_pct: Number(l.discount_pct) }));
  const partIds = [...new Set(lines.map((l) => l.part_id).filter((x): x is string => !!x))];
  const [parts, claims, payer] = await Promise.all([
    partIds.length ? rows<{ id: string; part_number: string }>(await pm.from('parts').select('id, part_number').in('id', partIds), 'parts') : Promise.resolve([] as Array<{ id: string; part_number: string }>),
    rows<{ id: string; status: string; claimed_cents: number; claim_number: string | null }>(await pm.from('warranty_claims').select('id, status, claimed_cents, claim_number').eq('work_order_id', wo.id), 'claims'),
    customerNames(db, [wo.payer_customer_id]),
  ]);
  return {
    order: wo,
    lines,
    partNumbers: Object.fromEntries(parts.map((p) => [p.id, p.part_number])),
    claims,
    payerName: wo.payer_customer_id ? payer[wo.payer_customer_id] ?? null : null,
  };
});

/** Add, change and remove RO lines by type and pay type; draft a warranty claim from the warranty lines. */
export const POST = route({ access: { cap: 'projects.store', action: 'edit' }, mask: 'repair_order', body: Op }, async ({ db, params, body, tenant }) => {
  const wo = await downs<Wo>(db, 'work_orders', 'id, job_id, location_id, number, kind, status, payer_customer_id, asset_id', params.woId!, 'That repair order was not found.');
  assertCompany(tenant, wo.location_id);
  const pm = db.schema('pm');
  switch (body.op) {
    case 'add_line': {
      if (body.kind === 'PART' && !body.partId && !body.description) throw new HttpError(422, 'Key a part number or describe the part.', 'VALIDATION');
      if (body.kind !== 'PART' && !body.description && !body.laborOp) throw new HttpError(422, 'Describe the line.', 'VALIDATION');
      const last = rows<{ sort: number }>(await pm.from('work_order_lines').select('sort').eq('work_order_id', wo.id).order('sort', { ascending: false }).limit(1), 'last line');
      const labor = body.kind === 'LABOR';
      const qty = labor && body.flagHours ? body.flagHours : body.qty;
      await dwrite(pm.from('work_order_lines').insert({
        job_id: wo.job_id, work_order_id: wo.id, sort: (last[0]?.sort ?? -1) + 1, kind: body.kind, status: 'APPROVED',
        description: body.description || (labor && body.laborOp ? `Labor op ${body.laborOp}` : null),
        qty, uom: labor ? 'HR' : 'EA', unit_price_cents: body.unitPriceCents ?? null, unit_cost_cents: body.unitCostCents ?? null,
        pay_type: body.payType, labor_op: body.laborOp || null, flag_hours: labor ? body.flagHours ?? qty : null,
        part_id: body.kind === 'PART' ? body.partId ?? null : null, stock_location_id: body.kind === 'PART' ? body.stockLocationId ?? null : null,
      }).select('id'), 'add line');
      return { ok: true };
    }
    case 'update_line': {
      const patch: Record<string, unknown> = {};
      if (body.payType !== undefined) patch.pay_type = body.payType;
      if (body.description !== undefined && body.description) patch.description = body.description;
      if (body.laborOp !== undefined) patch.labor_op = body.laborOp || null;
      if (body.flagHours !== undefined) patch.flag_hours = body.flagHours;
      if (body.qty !== undefined) patch.qty = body.qty;
      if (body.unitPriceCents !== undefined) patch.unit_price_cents = body.unitPriceCents;
      if (body.unitCostCents !== undefined) patch.unit_cost_cents = body.unitCostCents;
      if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
      const r = await dwrite<unknown[]>(pm.from('work_order_lines').update(patch).eq('id', body.lineId).eq('work_order_id', wo.id).select('id'), 'update line');
      if (!r.length) throw new HttpError(404, 'That line was not found on this repair order.', 'NOT_FOUND');
      return { ok: true };
    }
    case 'remove_line': {
      const r = await dwrite<unknown[]>(pm.from('work_order_lines').delete().eq('id', body.lineId).eq('work_order_id', wo.id).select('id'), 'remove line');
      if (!r.length) throw new HttpError(404, 'That line was not found on this repair order.', 'NOT_FOUND');
      return { ok: true };
    }
    case 'claim': {
      const id = await dcall<string>(db, 'create_warranty_claim_from_ro', {
        p_wo: wo.id,
        p_attrs: attrs({ payer_customer_id: body.payerCustomerId, oem_vendor_id: body.oemVendorId, claim_number: body.claimNumber, failure_code: body.failureCode, labor_op: body.laborOp, filing_deadline: body.filingDeadline }),
      });
      return { ok: true, claimId: id };
    }
  }
});
