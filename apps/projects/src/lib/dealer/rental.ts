/**
 * Short-rental charge (DLR-63), mirroring pm._d5_rental_quote in migration 1125 for windows up to a
 * day: the cheapest of hours (at the minimum hours), half-day (≤ 4 h) and a day; the store's
 * minimum charge applies last; accessories at their day rate × billed days. Windows over a day are
 * 1109's pm.rental_charge (months / weeks / days) — the screen asks the database for those.
 */

export interface ShortRate {
  day_cents: number | null;
  hour_cents: number | null;
  half_day_cents: number | null;
  min_hours: number | null;
  min_charge_cents: number | null;
}

export interface ShortQuote {
  hours: number;
  basis: 'HOURS' | 'HALF_DAY' | 'DAY' | null;
  rental_cents: number;
  accessories_cents: number;
  total_cents: number;
}

/** Billed hours: whole hours, rounding up (a 61-minute rental is 2 hours). */
export function billedHours(startMs: number, endMs: number): number {
  return Math.ceil((endMs - startMs) / 3_600_000 - 0.0001);
}

export function shortQuote(rate: ShortRate, startMs: number, endMs: number, accessoryDayCents = 0): ShortQuote | null {
  if (endMs <= startMs) return { hours: 0, basis: null, rental_cents: 0, accessories_cents: 0, total_cents: 0 };
  const hrs = billedHours(startMs, endMs);
  if (hrs > 24 || (rate.hour_cents == null && rate.half_day_cents == null)) return null;
  let rent: number | null = null;
  let basis: ShortQuote['basis'] = null;
  if (rate.hour_cents != null) { rent = Math.max(hrs, rate.min_hours ?? 0) * rate.hour_cents; basis = 'HOURS'; }
  if (rate.half_day_cents != null && hrs <= 4 && (rent == null || rate.half_day_cents < rent)) { rent = rate.half_day_cents; basis = 'HALF_DAY'; }
  if (rate.day_cents != null && (rent == null || rate.day_cents < rent)) { rent = rate.day_cents; basis = 'DAY'; }
  const rental = Math.max(rent ?? 0, rate.min_charge_cents ?? 0);
  return { hours: hrs, basis, rental_cents: rental, accessories_cents: accessoryDayCents, total_cents: rental + accessoryDayCents };
}
