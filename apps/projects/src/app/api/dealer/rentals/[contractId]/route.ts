export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { dcall, downs, dwrite } from '@/lib/pm/dealer/rpc';
import { Cents, Meter, Text, attrs } from '@/lib/pm/dealer/schemas';

const Instant = z.string().datetime({ offset: true });

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('check_out'), meterOut: Meter, conditionOut: Text(1000).nullish(), outAt: Instant.nullish() }),
  z.object({
    op: z.literal('check_in'), meterIn: Meter, conditionIn: Text(1000).nullish(), damageCents: Cents.default(0), damageNotes: Text(1000).nullish(),
    fuelCents: Cents.default(0), cleaningCents: Cents.default(0), inAt: Instant.nullish(),
  }),
  z.object({ op: z.literal('bill'), through: Instant.nullish() }),
  z.object({ op: z.literal('cancel'), reason: Text(300).nullish() }),
  z.object({ op: z.literal('notes'), notes: Text(1000).nullish(), damageWaiver: z.boolean().optional() }),
]);

/** Check out (meter, condition), check in (meter, condition, damage, fuel, cleaning), bill, cancel. */
export const POST = route({ body: Op }, async ({ db, params, body, tenant }) => {
  const c = await downs<{ id: string; location_id: string; meter_out: number | null }>(db, 'rental_contracts', 'id, location_id, meter_out', params.contractId!, 'That rental was not found.');
  assertCompany(tenant, c.location_id);
  switch (body.op) {
    case 'check_out':
      await dcall(db, 'check_out_rental', { p_contract: c.id, p_meter_out: body.meterOut, p_condition_out: body.conditionOut || null, p_out_at: body.outAt ?? null });
      return { ok: true };
    case 'check_in':
      if (c.meter_out != null && body.meterIn < Number(c.meter_out)) throw new HttpError(422, `Meter in must be at least the meter out (${c.meter_out}).`, 'VALIDATION');
      await dcall(db, 'check_in_rental', {
        p_contract: c.id, p_meter_in: body.meterIn, p_condition_in: body.conditionIn || null, p_damage_cents: body.damageCents,
        p_attrs: attrs({ damage_notes: body.damageNotes, fuel_cents: body.fuelCents || undefined, cleaning_cents: body.cleaningCents || undefined }), p_in_at: body.inAt ?? null,
      });
      return { ok: true };
    case 'bill': {
      const id = await dcall<string>(db, 'bill_rental', { p_contract: c.id, p_through: body.through ?? null });
      return { ok: true, billingId: id };
    }
    case 'cancel':
      await dcall(db, 'cancel_rental', { p_contract: c.id, p_reason: body.reason || null });
      return { ok: true };
    case 'notes': {
      const patch: Record<string, unknown> = {};
      if (body.notes !== undefined) patch.notes = body.notes || null;
      if (body.damageWaiver !== undefined) patch.damage_waiver = body.damageWaiver;
      if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
      const r = await dwrite<unknown[]>(db.schema('pm').from('rental_contracts').update(patch).eq('id', c.id).select('id'), 'update rental');
      if (!r.length) throw new HttpError(422, 'Only a reserved or out rental can change.', 'PM_RENTAL_TRANSITION_INVALID');
      return { ok: true };
    }
  }
});
