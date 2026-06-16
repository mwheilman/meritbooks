/**
 * Payment-method authorization resolver (FPB §11a).
 *
 * Which methods appear on a customer's Pay Now is resolved most-specific-wins,
 * exactly like the rev-rec method resolver:
 *
 *     invoice override -> job -> customer -> entity/tenant default
 *
 * Each level is nullable; an unset (null/empty) level falls through to the next.
 * The resolved set is then intersected with what the ACTIVE payment provider
 * actually supports (Stripe = ACH+CARD, Dwolla = ACH only), so a provider swap
 * can never offer a method that can't be charged.
 *
 * Pure + dependency-free so it runs the same on the server (Pay Now page,
 * invoice issue) and is trivially unit-testable.
 */

export type PaymentMethod = 'ACH' | 'CARD';
export type PaymentProviderId = 'STRIPE' | 'DWOLLA';

/** What each provider can actually charge. */
export const PROVIDER_METHODS: Record<PaymentProviderId, PaymentMethod[]> = {
  STRIPE: ['ACH', 'CARD'],
  DWOLLA: ['ACH'], // ACH-only — no cards
};

/** Default posture when no level sets anything: ACH offered, card not automatic. */
export const DEFAULT_METHODS: PaymentMethod[] = ['ACH'];

export interface MethodCascadeLevels {
  /** invoice.payment_methods_allowed (most specific) */
  invoice?: string[] | null;
  /** core.jobs.payment_methods_allowed */
  job?: string[] | null;
  /** core.customers.payment_methods_allowed */
  customer?: string[] | null;
  /** core.locations.payment_methods_allowed (entity default, least specific) */
  entity?: string[] | null;
}

export interface SurchargeCascadeLevels {
  invoice?: boolean | null;
  job?: boolean | null;
  customer?: boolean | null;
  entity?: boolean | null;
}

function isMethod(v: string): v is PaymentMethod {
  return v === 'ACH' || v === 'CARD';
}

/** First non-empty level in the cascade, normalized to valid PaymentMethod[]. */
function firstSet(levels: MethodCascadeLevels): PaymentMethod[] | null {
  for (const raw of [levels.invoice, levels.job, levels.customer, levels.entity]) {
    if (raw && raw.length > 0) {
      const cleaned = [...new Set(raw.map((m) => m.toUpperCase()).filter(isMethod))];
      if (cleaned.length > 0) return cleaned as PaymentMethod[];
    }
  }
  return null;
}

/**
 * Resolve the payment methods to show on Pay Now for one invoice.
 * @returns methods in stable order (ACH first, then CARD), provider-supported only.
 */
export function resolvePaymentMethods(
  levels: MethodCascadeLevels,
  provider: PaymentProviderId
): PaymentMethod[] {
  const chosen = firstSet(levels) ?? DEFAULT_METHODS;
  const supported = PROVIDER_METHODS[provider] ?? DEFAULT_METHODS;
  const intersected = chosen.filter((m) => supported.includes(m));
  // Never return an empty set — fall back to whatever the provider can do.
  const result = intersected.length > 0 ? intersected : supported;
  // Stable order: ACH before CARD.
  return (['ACH', 'CARD'] as PaymentMethod[]).filter((m) => result.includes(m));
}

/**
 * Resolve whether a card surcharge applies, most-specific-wins.
 * Default true (card is offered only with the fee opt-in). An explicit false at
 * any level absorbs the card cost instead.
 */
export function resolveSurchargeEnabled(levels: SurchargeCascadeLevels): boolean {
  for (const v of [levels.invoice, levels.job, levels.customer, levels.entity]) {
    if (v === true || v === false) return v;
  }
  return true;
}
