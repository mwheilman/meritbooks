/**
 * Fee resolution — Layer 1 of the two-layer marketplace fee model.
 *
 * Layer 1 = what MeritBooks charges the merchant for processing a payment. Set
 * per merchant (core.merchant_fee_schedules), so this is the application_fee on
 * the Stripe destination charge. Replaces the hardcoded ACH_PCT/CARD_PCT.
 *
 * `computeFee` is pure and integer-only: basis points, cap, floor, all in cents.
 * No floats reach money. It is unit-tested against exact cents, including the
 * case the old constants got wrong — a $150,000 ACH at "1% capped at $10" is
 * $10, not $1,500.
 *
 * Layer 2 (whether the merchant passes this fee to their customer) is decided
 * separately by the surcharge cascade in resolve-payment-methods.ts and applied
 * in the intent route; it does not change what MeritBooks charges — only who
 * bears it.
 */

export type FeeMethod = 'ACH' | 'CARD';

export interface MerchantFeeSchedule {
  achFeeBps: number;
  achFeeCapCents: number | null;
  achFeeMinCents: number | null;
  cardFeeBps: number;
  cardFeeCapCents: number | null;
  cardFeeMinCents: number | null;
}

/**
 * Platform default when a merchant has no schedule yet. ACH 1% capped at $10,
 * card 3% uncapped — the agreed defaults. A merchant always resolves to
 * *something*, so a payment never fails or charges $0 for lack of config.
 */
export const DEFAULT_FEE_SCHEDULE: MerchantFeeSchedule = {
  achFeeBps: 100,
  achFeeCapCents: 1000,
  achFeeMinCents: null,
  cardFeeBps: 300,
  cardFeeCapCents: null,
  cardFeeMinCents: null,
};

/**
 * The fee MeritBooks charges on a payment of `baseCents` by `method`.
 *
 *   fee = clamp( round(base × bps / 10000), floor, cap )
 *
 * - bps/cap/floor come from the merchant's schedule per method.
 * - cap null = uncapped; floor null = no floor.
 * - result is always an integer cent count, 0 ≤ fee ≤ baseCents.
 */
export function computeFee(
  schedule: MerchantFeeSchedule,
  method: FeeMethod,
  baseCents: number,
): number {
  if (!Number.isInteger(baseCents) || baseCents < 0) {
    throw new Error(`baseCents must be a non-negative integer, got ${baseCents}`);
  }
  const bps = method === 'ACH' ? schedule.achFeeBps : schedule.cardFeeBps;
  const cap = method === 'ACH' ? schedule.achFeeCapCents : schedule.cardFeeCapCents;
  const floor = method === 'ACH' ? schedule.achFeeMinCents : schedule.cardFeeMinCents;

  let fee = Math.round((baseCents * bps) / 10000);
  if (floor != null) fee = Math.max(fee, floor);
  if (cap != null) fee = Math.min(fee, cap);
  // Never exceed the payment itself, and never negative.
  fee = Math.max(0, Math.min(fee, baseCents));
  return fee;
}

/** Row shape from core.merchant_fee_schedules → the typed schedule. */
export function scheduleFromRow(row: {
  ach_fee_bps: number;
  ach_fee_cap_cents: number | string | null;
  ach_fee_min_cents: number | string | null;
  card_fee_bps: number;
  card_fee_cap_cents: number | string | null;
  card_fee_min_cents: number | string | null;
}): MerchantFeeSchedule {
  const n = (v: number | string | null): number | null => (v == null ? null : Number(v));
  return {
    achFeeBps: Number(row.ach_fee_bps),
    achFeeCapCents: n(row.ach_fee_cap_cents),
    achFeeMinCents: n(row.ach_fee_min_cents),
    cardFeeBps: Number(row.card_fee_bps),
    cardFeeCapCents: n(row.card_fee_cap_cents),
    cardFeeMinCents: n(row.card_fee_min_cents),
  };
}

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The merchant's active fee schedule, or the platform default if none is set.
 * Never throws for a missing schedule — absence degrades to the default so a
 * payment can always be priced.
 */
export async function resolveMerchantFeeSchedule(
  supabase: SupabaseClient,
  orgId: string,
): Promise<MerchantFeeSchedule> {
  const { data, error } = await supabase
    .schema('core')
    .from('merchant_fee_schedules')
    .select('ach_fee_bps, ach_fee_cap_cents, ach_fee_min_cents, card_fee_bps, card_fee_cap_cents, card_fee_min_cents')
    .eq('org_id', orgId)
    .is('effective_to', null)
    .maybeSingle();

  // A GENUINE query failure must not be mistaken for "no schedule set". Silently
  // defaulting on a broken query would misprice every payment at the platform
  // rate instead of the merchant's negotiated rate — the fee that becomes both
  // MeritBooks' revenue and the merchant's expense. Fail loudly; a retryable
  // payment error beats quietly charging the wrong amount.
  if (error) {
    throw new Error(`Failed to load fee schedule for org ${orgId}: ${error.message}`);
  }
  // No row is legitimate — the merchant has no custom schedule yet. Default.
  return data ? scheduleFromRow(data as Parameters<typeof scheduleFromRow>[0]) : DEFAULT_FEE_SCHEDULE;
}
