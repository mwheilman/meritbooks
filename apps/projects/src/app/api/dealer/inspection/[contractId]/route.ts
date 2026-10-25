export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { xcall, xrows } from '@/lib/dealer/rpc';
import { PosCents, Text, Uuid } from '@/lib/dealer/schemas';

/** Check-out and check-in inspections of a rental, and the compare (new damage, fuel, hours, cleaning, priced). */
export const GET = route({ access: { cap: 'projects.store', action: 'view' }, mask: 'rental' }, async ({ db, params }) => {
  const [inspections, compare] = await Promise.all([
    xrows<Record<string, unknown>>(db.schema('pm').from('dlr_rental_inspections').select('id, phase, meter, fuel_eighths, clean, zones, photo_document_ids, notes, inspected_by, inspected_at').eq('contract_id', params.contractId!).order('inspected_at'), 'inspections'),
    xcall<Record<string, unknown>>(db, 'dlr_rental_damage_compare', { p_contract: params.contractId! }),
  ]);
  return { inspections, compare };
});

const Zone = z.object({ zone: z.string().trim().min(1).max(40), condition: z.enum(['OK', 'SCRATCH', 'DENT', 'CRACK', 'BROKEN', 'MISSING']), note: Text(200).nullish() });

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('record'), phase: z.enum(['OUT', 'IN']), meter: z.number().min(0).max(1e7), fuelEighths: z.number().int().min(0).max(8), clean: z.boolean(), zones: z.array(Zone).max(40).default([]), photoIds: z.array(Uuid).max(40).default([]), notes: Text(1000).nullish() }),
  z.object({ op: z.literal('charges'), damageCents: PosCents, fuelCents: PosCents, cleaningCents: PosCents, notes: Text(500).nullish() }),
]);

export const POST = route({ access: { cap: 'projects.store', action: 'edit' }, mask: 'rental', body: Op }, async ({ db, params, body }) => {
  if (body.op === 'record') {
    return { id: await xcall<string>(db, 'dlr_record_rental_inspection', { p_contract: params.contractId!, p_phase: body.phase, p_meter: body.meter, p_fuel_eighths: body.fuelEighths, p_clean: body.clean, p_zones: body.zones, p_photos: body.photoIds, p_notes: body.notes ?? null }) };
  }
  return { id: await xcall<string>(db, 'dlr_apply_rental_charges', { p_contract: params.contractId!, p_damage_cents: body.damageCents, p_fuel_cents: body.fuelCents, p_cleaning_cents: body.cleaningCents, p_notes: body.notes ?? null }) };
});
