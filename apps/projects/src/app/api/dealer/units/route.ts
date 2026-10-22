export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { dcall } from '@/lib/pm/dealer/rpc';
import { Cents, ConditionZ, Day, Meter, Text, Uuid, Year, attrs } from '@/lib/pm/dealer/schemas';

const Receive = z.object({
  op: z.literal('receive'),
  companyId: Uuid,
  /** An ON_ORDER / IN_TRANSIT unit arriving (else a new unit). */
  unitId: Uuid.nullish(),
  serialNumber: Text(80).nullish(),
  make: Text(60).nullish(),
  model: Text(80).nullish(),
  modelYear: Year.nullish(),
  vin: Text(40).nullish(),
  category: Text(40).nullish(),
  condition: ConditionZ.default('NEW'),
  costCents: Cents.default(0),
  mfrInvoiceRef: Text(60).nullish(),
  mfrVendorId: Uuid.nullish(),
  stockLocationId: Uuid.nullish(),
  stockNumber: Text(24).nullish(),
  receivedOn: Day.nullish(),
  retailPriceCents: Cents.nullish(),
  advertisedPriceCents: Cents.nullish(),
  meterReading: Meter.nullish(),
  description: Text(300).nullish(),
  attachments: z.array(Text(120)).max(20).default([]),
  floorLenderVendorId: Uuid.nullish(),
  floorProgramRef: Text(60).nullish(),
}).refine((b) => !!b.unitId || !!b.serialNumber, { message: 'Key the serial number from the unit', path: ['serialNumber'] })
  .refine((b) => !!b.unitId || !!b.model, { message: 'Give the model', path: ['model'] });

const Order = z.object({
  op: z.literal('order'),
  companyId: Uuid,
  make: Text(60).nullish(),
  model: z.string().trim().min(1, 'Give the model').max(80),
  modelYear: Year.nullish(),
  category: Text(40).nullish(),
  serialNumber: Text(80).nullish(),
  retailPriceCents: Cents.nullish(),
  mfrVendorId: Uuid.nullish(),
  description: Text(300).nullish(),
});

const Body = z.union([Receive, Order]);

/**
 * Receive a unit into stock (pm.receive_unit: DEALER_UNIT_RECEIVED to Merit Books with the
 * manufacturer invoice as its base cost) or record one on order (pm.order_unit; nothing reaches
 * Books until it is received).
 */
export const POST = route({ access: { cap: 'projects.store', action: 'create' }, mask: 'dealer_unit', body: Body }, async ({ db, body, tenant }) => {
  assertCompany(tenant, body.companyId);
  if (body.op === 'order') {
    const id = await dcall<string>(db, 'order_unit', {
      p_location: body.companyId, p_make: body.make || null, p_model: body.model,
      p_attrs: attrs({ model_year: body.modelYear, category: body.category, serial_number: body.serialNumber, retail_price_cents: body.retailPriceCents, mfr_vendor_id: body.mfrVendorId, description: body.description }),
    });
    return { unitId: id };
  }
  const id = await dcall<string | null>(db, 'receive_unit', {
    p_location: body.companyId,
    p_serial: body.serialNumber || null,
    p_make: body.make || null,
    p_model: body.model || null,
    p_cost_cents: body.costCents,
    p_attrs: attrs({
      condition: body.condition, model_year: body.modelYear, vin: body.vin, category: body.category, stock_number: body.stockNumber,
      stock_location_id: body.stockLocationId, received_on: body.receivedOn, mfr_invoice_ref: body.mfrInvoiceRef, mfr_vendor_id: body.mfrVendorId,
      retail_price_cents: body.retailPriceCents, advertised_price_cents: body.advertisedPriceCents, meter_reading: body.meterReading,
      description: body.description, attachments: body.attachments.length ? body.attachments : undefined,
      floor_plan: body.floorLenderVendorId || body.floorProgramRef ? attrs({ lender_vendor_id: body.floorLenderVendorId, program_ref: body.floorProgramRef }) : undefined,
    }),
    p_unit: body.unitId ?? null,
  });
  if (!id) throw new HttpError(500, 'The unit was not received. Try again.', 'CREATE_FAILED');
  const row = await db.schema('pm').from('assets').select('stock_number').eq('id', id).maybeSingle();
  return { unitId: id, stockNumber: (row.data as { stock_number: string | null } | null)?.stock_number ?? null };
});
