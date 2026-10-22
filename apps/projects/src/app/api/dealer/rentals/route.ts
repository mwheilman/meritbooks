export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { rows } from '@/lib/pm/db';
import { pickRentalRate } from '@/lib/pm/dealer/math';
import { dcall } from '@/lib/pm/dealer/rpc';
import { Cents, Text, Uuid, attrs } from '@/lib/pm/dealer/schemas';
import { RENTAL_RATE_COLS, type RentalCharge, type RentalRateRow } from '@/lib/pm/dealer/types';

const Instant = z.string().datetime({ offset: true });

const Query = z.object({
  unitId: z.string().uuid().optional(),
  contractId: z.string().uuid().optional(),
  start: Instant.optional(),
  end: Instant.optional(),
  through: Instant.optional(),
});

/**
 * Rate preview from pm.rental_charge: for a new reservation (unit + window, at the rate that covers
 * the unit) or for the next bill on a contract (its pinned rates, from the last billed point).
 */
export const GET = route({ query: Query }, async ({ db, query, tenant }) => {
  const pm = db.schema('pm');
  let rate: { day: number | null; week: number | null; month: number | null; waiverPct: number | null; label: string | null } | null = null;
  let start: string | undefined = query.start;
  let end: string | undefined = query.end;
  let fees = 0;
  if (query.contractId) {
    const c = rows<{ location_id: string; status: string; rate_day_cents: number | null; rate_week_cents: number | null; rate_month_cents: number | null; damage_waiver: boolean; damage_waiver_pct: number | null; checked_out_at: string | null; checked_in_at: string | null; billed_through: string | null; fuel_cents: number; cleaning_cents: number; damage_cents: number; delivery_cents: number }>(
      await pm.from('rental_contracts').select('location_id, status, rate_day_cents, rate_week_cents, rate_month_cents, damage_waiver, damage_waiver_pct, checked_out_at, checked_in_at, billed_through, fuel_cents, cleaning_cents, damage_cents, delivery_cents').eq('id', query.contractId),
      'rental contract',
    )[0];
    if (!c) throw new HttpError(404, 'That rental was not found.', 'NOT_FOUND');
    assertCompany(tenant, c.location_id);
    if (c.status !== 'OUT' && c.status !== 'RETURNED') return { charge: null, rate: null, waiverCents: 0, feesCents: 0 };
    rate = { day: c.rate_day_cents, week: c.rate_week_cents, month: c.rate_month_cents, waiverPct: c.damage_waiver ? Number(c.damage_waiver_pct ?? 0) : null, label: null };
    start = c.billed_through ?? c.checked_out_at ?? undefined;
    end = c.status === 'RETURNED' ? c.checked_in_at ?? undefined : query.through ?? new Date().toISOString();
    fees = (c.status === 'RETURNED' ? Number(c.fuel_cents) + Number(c.cleaning_cents) + Number(c.damage_cents) : 0) + (c.billed_through ? 0 : Number(c.delivery_cents));
  } else if (query.unitId) {
    const u = rows<{ id: string; location_id: string; model: string | null; category: string | null }>(await pm.from('assets').select('id, location_id, model, category').eq('id', query.unitId), 'unit')[0];
    if (!u) throw new HttpError(404, 'That unit was not found.', 'NOT_FOUND');
    assertCompany(tenant, u.location_id);
    const rates = rows<RentalRateRow>(await pm.from('rental_rates').select(RENTAL_RATE_COLS).eq('location_id', u.location_id).eq('is_active', true), 'rental rates');
    const r = pickRentalRate(rates, u);
    if (!r) return { charge: null, rate: null, waiverCents: 0, feesCents: 0, noRate: true };
    rate = { day: r.day_cents, week: r.week_cents, month: r.month_cents, waiverPct: r.damage_waiver_pct == null ? null : Number(r.damage_waiver_pct), label: r.label };
  } else {
    throw new HttpError(422, 'Pick a unit or a rental.', 'VALIDATION');
  }
  if (!start || !end) return { charge: null, rate, waiverCents: 0, feesCents: fees };
  const charge = await dcall<RentalCharge>(db, 'rental_charge', { p_day: rate.day, p_week: rate.week, p_month: rate.month, p_start: start, p_end: end });
  const waiverCents = rate.waiverPct ? Math.round(Number(charge.rental_cents) * rate.waiverPct) : 0;
  return { charge, rate, waiverCents, feesCents: fees, start, end };
});

const Body = z.object({
  unitId: Uuid,
  customerId: Uuid,
  start: Instant,
  end: Instant,
  damageWaiver: z.boolean().default(false),
  deliveryCents: Cents.default(0),
  notes: Text(1000).nullish(),
}).refine((b) => Date.parse(b.end) > Date.parse(b.start), { message: 'The rental ends before it starts', path: ['end'] });

/** Reserve a fleet unit (pm.reserve_rental pins the covering rate; the database refuses a double booking). */
export const POST = route({ body: Body }, async ({ db, body, tenant }) => {
  const u = rows<{ location_id: string }>(await db.schema('pm').from('assets').select('location_id').eq('id', body.unitId), 'unit')[0];
  if (!u) throw new HttpError(404, 'That unit was not found.', 'NOT_FOUND');
  assertCompany(tenant, u.location_id);
  const id = await dcall<string>(db, 'reserve_rental', {
    p_unit: body.unitId, p_customer: body.customerId, p_start: body.start, p_end: body.end,
    p_attrs: attrs({ damage_waiver: body.damageWaiver, delivery_cents: body.deliveryCents || undefined, notes: body.notes }),
  });
  return { contractId: id };
});
