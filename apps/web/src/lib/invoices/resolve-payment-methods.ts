/**
 * Payment-method authorization resolver (FPB §11a).
 *
 * Methods: CHECK (mail a paper check — offline), ACH (bank transfer), CARD.
 * Resolved most-specific-wins: invoice → job → customer → entity default.
 * The online methods (ACH, CARD) are intersected with what the active payment
 * provider supports (Stripe = ACH+CARD, Dwolla = ACH). CHECK is always allowed
 * when chosen — it's just an instruction to mail a check, no processor involved.
 *
 * Pure + dependency-free so it runs identically on the server and is unit-testable.
 */

export type PaymentMethod = 'CHECK' | 'ACH' | 'CARD';
export type PaymentProviderId = 'STRIPE' | 'DWOLLA';

/** Online methods each provider can actually charge (CHECK is offline, excluded). */
export const PROVIDER_ONLINE_METHODS: Record<PaymentProviderId, PaymentMethod[]> = {
  STRIPE: ['ACH', 'CARD'],
  DWOLLA: ['ACH'],
};

/** Default posture when nothing is set: accept check + bank transfer; card off. */
export const DEFAULT_METHODS: PaymentMethod[] = ['CHECK', 'ACH'];

const ONLINE: PaymentMethod[] = ['ACH', 'CARD'];
const ORDER: PaymentMethod[] = ['CHECK', 'ACH', 'CARD'];

export interface MethodCascadeLevels {
  invoice?: string[] | null;
  job?: string[] | null;
  customer?: string[] | null;
  entity?: string[] | null;
}

export interface SurchargeCascadeLevels {
  invoice?: boolean | null;
  job?: boolean | null;
  customer?: boolean | null;
  entity?: boolean | null;
}

function isMethod(v: string): v is PaymentMethod {
  return v === 'CHECK' || v === 'ACH' || v === 'CARD';
}

function firstSet(levels: MethodCascadeLevels): PaymentMethod[] | null {
  for (const raw of [levels.invoice, levels.job, levels.customer, levels.entity]) {
    if (raw && raw.length > 0) {
      const cleaned = [...new Set(raw.map((m) => m.toUpperCase()).filter(isMethod))] as PaymentMethod[];
      if (cleaned.length > 0) return cleaned;
    }
  }
  return null;
}

/**
 * Resolve the payment methods for one invoice. Online methods are filtered to
 * what the provider supports; CHECK passes through untouched.
 * @returns methods in stable order: CHECK, ACH, CARD.
 */
export function resolvePaymentMethods(
  levels: MethodCascadeLevels,
  provider: PaymentProviderId
): PaymentMethod[] {
  const chosen = firstSet(levels) ?? DEFAULT_METHODS;
  const onlineSupported = PROVIDER_ONLINE_METHODS[provider] ?? ['ACH'];
  const kept = chosen.filter((m) => (ONLINE.includes(m) ? onlineSupported.includes(m) : true));
  const result = kept.length > 0 ? kept : DEFAULT_METHODS;
  return ORDER.filter((m) => result.includes(m));
}

/** Online methods only (the ones that get a Pay button on the hosted page). */
export function onlineMethods(methods: PaymentMethod[]): PaymentMethod[] {
  return methods.filter((m) => ONLINE.includes(m));
}

/**
 * Card surcharge posture, most-specific-wins. true = the card processing fee is
 * passed to the customer at payment; false = the business absorbs it. Default
 * true (passed on) unless a level says otherwise.
 */
export function resolveSurchargeEnabled(levels: SurchargeCascadeLevels): boolean {
  for (const v of [levels.invoice, levels.job, levels.customer, levels.entity]) {
    if (v === true || v === false) return v;
  }
  return true;
}
