export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { dcall, downs, dwrite } from '@/lib/pm/dealer/rpc';
import { loadUnitDetail } from '@/lib/pm/dealer/unit-queries';
import { AddableCostZ, Cents, Day, Text, UnitStatusZ, Uuid, attrs } from '@/lib/pm/dealer/schemas';

const Op = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('cost'),
    costType: AddableCostZ,
    amountCents: z.number().int().positive('The cost must be more than zero').max(1e12),
    laborCents: Cents.nullish(),
    partsCents: Cents.nullish(),
    laborHours: z.number().min(0).max(10_000).nullish(),
    vendorId: Uuid.nullish(),
    vendorInvoiceRef: Text(60).nullish(),
    memo: Text(300).nullish(),
  }),
  z.object({ op: z.literal('status'), to: UnitStatusZ, reason: Text(300).nullish() }),
  z.object({ op: z.literal('transfer'), toStockLocationId: Uuid, reason: Text(300).nullish() }),
  z.object({ op: z.literal('pdi'), summary: Text(200).nullish() }),
  z.object({ op: z.literal('register'), registeredOn: Day.nullish(), warrantyExpiresOn: Day.nullish(), oemRef: Text(60).nullish() }),
  z.object({
    op: z.literal('update'),
    stockNumber: Text(24).nullish(),
    vin: Text(40).nullish(),
    category: Text(40).nullish(),
    retailPriceCents: Cents.nullish(),
    advertisedPriceCents: Cents.nullish(),
    attachments: z.array(Text(120)).max(20).optional(),
    mfrVendorId: Uuid.nullish(),
  }),
  z.object({ op: z.literal('deal'), customerId: Uuid.nullish() }),
]);

export const GET = route({}, async ({ db, params }) => {
  const d = await loadUnitDetail(db, params.unitId!);
  if (!d) throw new HttpError(404, 'That unit was not found.', 'NOT_FOUND');
  return d;
});

/** Unit actions: add cost, change status, transfer, open PDI, register warranty, edit, start a deal. */
export const POST = route({ body: Op }, async ({ db, params, body, tenant }) => {
  const u = await downs<{ id: string; location_id: string; serial_number: string | null }>(db, 'assets', 'id, location_id, serial_number', params.unitId!, 'That unit was not found.');
  assertCompany(tenant, u.location_id);
  switch (body.op) {
    case 'cost': {
      if ((body.laborCents ?? 0) + (body.partsCents ?? 0) > body.amountCents) throw new HttpError(422, 'Labor plus parts cannot be more than the cost.', 'VALIDATION');
      const id = await dcall<string>(db, 'add_unit_cost', {
        p_unit: u.id, p_cost_type: body.costType, p_amount_cents: body.amountCents, p_memo: body.memo || null,
        p_attrs: attrs({ labor_cents: body.laborCents, parts_cents: body.partsCents, labor_hours: body.laborHours, vendor_id: body.vendorId, vendor_invoice_ref: body.vendorInvoiceRef }),
      });
      return { ok: true, costId: id };
    }
    case 'status':
      await dcall(db, 'set_dealer_unit_status', { p_unit: u.id, p_status: body.to, p_reason: body.reason || null });
      return { ok: true };
    case 'transfer':
      await dcall(db, 'transfer_unit', { p_unit: u.id, p_to_stock_location: body.toStockLocationId, p_reason: body.reason || null });
      return { ok: true };
    case 'pdi': {
      const wo = await dcall<string>(db, 'open_unit_pdi', { p_unit: u.id, p_summary: body.summary || null });
      return { ok: true, workOrderId: wo };
    }
    case 'register':
      if (body.registeredOn && body.warrantyExpiresOn && body.warrantyExpiresOn < body.registeredOn) throw new HttpError(422, 'The warranty ends before it starts.', 'VALIDATION');
      await dcall(db, 'register_unit_warranty', { p_unit: u.id, p_registered_on: body.registeredOn ?? null, p_warranty_expires_on: body.warrantyExpiresOn ?? null, p_oem_ref: body.oemRef || null });
      return { ok: true };
    case 'update': {
      const patch: Record<string, unknown> = {};
      if (body.stockNumber !== undefined) patch.stock_number = body.stockNumber ? body.stockNumber.toUpperCase() : null;
      if (body.vin !== undefined) patch.vin = body.vin || null;
      if (body.category !== undefined) patch.category = body.category || null;
      if (body.retailPriceCents !== undefined) patch.retail_price_cents = body.retailPriceCents;
      if (body.advertisedPriceCents !== undefined) patch.advertised_price_cents = body.advertisedPriceCents;
      if (body.attachments !== undefined) patch.attachments = body.attachments;
      if (body.mfrVendorId !== undefined) patch.mfr_vendor_id = body.mfrVendorId;
      if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
      await dwrite(db.schema('pm').from('assets').update(patch).eq('id', u.id).select('id'), 'update unit');
      return { ok: true };
    }
    case 'deal': {
      const dealId = await dcall<string>(db, 'create_deal', { p_location: u.location_id, p_customer: body.customerId ?? null, p_attrs: {} });
      await dwrite(db.schema('pm').from('dealer_deal_lines').insert({ deal_id: dealId, line_type: 'UNIT', asset_id: u.id, qty: 1, line_no: 1, sort: 0 }).select('id'), 'add the unit to the deal');
      return { ok: true, dealId };
    }
  }
});
