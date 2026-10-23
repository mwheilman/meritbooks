import Stripe from 'stripe';

/**
 * Stripe platform adapter (Connect, platform-pays-fees model).
 *
 * The platform's secret key lives in the Vercel environment (STRIPE_SECRET_KEY),
 * not in a tenant connection — it's the single key the platform uses to act on
 * behalf of all connected accounts. Per-tenant data is the connected account id
 * (acct_...), stored as account_handle on core.provider_connections.
 *
 * Connected accounts are Express: Stripe hosts KYC/onboarding, the platform keeps
 * payout + fee control. Onboarding is launched via Account Links.
 */

let _stripe: Stripe | null = null;

export function getPlatformStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error('STRIPE_SECRET_KEY is not set in the environment.');
  }
  if (!_stripe) {
    // The fetch HTTP client avoids stale keep-alive sockets that cause
    // StripeConnectionError on Vercel serverless functions; retries cover blips.
    _stripe = new Stripe(key, {
      httpClient: Stripe.createFetchHttpClient(),
      maxNetworkRetries: 2,
      timeout: 20000,
    });
  }
  return _stripe;
}

export function isStripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

// Mode (test vs live) is derived from the key — see lib/money/payments-mode.ts. Nothing
// in this adapter decides or labels the mode.

/**
 * Create a new Express connected account for ONE company (migration 175: one account
 * per company, so each company's customer payments settle to that company's own bank).
 * The org + company ids ride in the account's metadata so a webhook — or a human in the
 * Stripe dashboard — can always tell whose account it is. Returns the acct_ id.
 */
export async function createConnectedAccount(
  opts: { email?: string | null; businessName?: string | null; metadata?: Record<string, string> } | string | null = null,
): Promise<string> {
  const o = typeof opts === 'string' || opts === null ? { email: opts } : opts;
  const stripe = getPlatformStripe();
  const account = await stripe.accounts.create({
    type: 'express',
    email: o.email ?? undefined,
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
      us_bank_account_ach_payments: { requested: true },
    },
    business_profile: o.businessName ? { name: o.businessName } : undefined,
    metadata: o.metadata,
  });
  return account.id;
}

/** Create a hosted onboarding link the company completes to activate its account. */
export async function createOnboardingLink(
  accountId: string,
  refreshUrl: string,
  returnUrl: string,
): Promise<string> {
  const stripe = getPlatformStripe();
  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: 'account_onboarding',
  });
  return link.url;
}

/** A one-time link into the company's Stripe Express dashboard (payout bank, statements). */
export async function createDashboardLink(accountId: string): Promise<string> {
  const link = await getPlatformStripe().accounts.createLoginLink(accountId);
  return link.url;
}

export interface ConnectedAccountStatus {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}

/** Everything the Payments screen shows about a connected account. No secrets, last 4 only. */
export interface ConnectedAccountDetails extends ConnectedAccountStatus {
  disabledReason: string | null;
  requirementsDue: string[];
  payoutBankName: string | null;
  payoutBankLast4: string | null;
}

/** The subset of a Stripe Account object `accountDetailsFromObject` reads (keeps it testable). */
export interface StripeAccountLike {
  charges_enabled?: boolean | null;
  payouts_enabled?: boolean | null;
  details_submitted?: boolean | null;
  requirements?: { disabled_reason?: string | null; currently_due?: string[] | null; past_due?: string[] | null } | null;
  external_accounts?: {
    data?: Array<{ object?: string; bank_name?: string | null; last4?: string | null; default_for_currency?: boolean | null }>;
  } | null;
}

/** Normalize a Stripe Account (API response or `account.updated` payload). Pure. */
export function accountDetailsFromObject(a: StripeAccountLike): ConnectedAccountDetails {
  const due = [...(a.requirements?.past_due ?? []), ...(a.requirements?.currently_due ?? [])];
  const banks = (a.external_accounts?.data ?? []).filter((x) => (x.object ?? 'bank_account') === 'bank_account');
  const bank = banks.find((b) => b.default_for_currency) ?? banks[0] ?? null;
  const last4 = bank?.last4 && /^[0-9]{4}$/.test(bank.last4) ? bank.last4 : null;
  return {
    chargesEnabled: !!a.charges_enabled,
    payoutsEnabled: !!a.payouts_enabled,
    detailsSubmitted: !!a.details_submitted,
    disabledReason: a.requirements?.disabled_reason ?? null,
    requirementsDue: [...new Set(due)],
    payoutBankName: bank?.bank_name ?? null,
    payoutBankLast4: last4,
  };
}

/** Current onboarding/capability status for a connected account. */
export async function getConnectedAccountStatus(accountId: string): Promise<ConnectedAccountStatus> {
  const d = await getConnectedAccountDetails(accountId);
  return { chargesEnabled: d.chargesEnabled, payoutsEnabled: d.payoutsEnabled, detailsSubmitted: d.detailsSubmitted };
}

/** Full status + payout bank (last 4) for a connected account. */
export async function getConnectedAccountDetails(accountId: string): Promise<ConnectedAccountDetails> {
  const a = await getPlatformStripe().accounts.retrieve(accountId);
  return accountDetailsFromObject(a as unknown as StripeAccountLike);
}

/**
 * Fully refund a destination-charge PaymentIntent: pull the transfer back from the
 * connected account and return the platform application fee, so the merchant's net
 * from the whole cycle is zero. Idempotent on the key (one refund per PaymentIntent).
 */
export async function refundDestinationPaymentIntent(paymentIntentId: string, idempotencyKey: string): Promise<{ id: string; status: string | null }> {
  const r = await getPlatformStripe().refunds.create(
    { payment_intent: paymentIntentId, reverse_transfer: true, refund_application_fee: true },
    { idempotencyKey },
  );
  return { id: r.id, status: r.status ?? null };
}

/** The connected account a destination-charge PaymentIntent pays out to, if any. */
export function destinationOf(pi: { transfer_data?: { destination?: string | { id: string } | null } | null }): string | null {
  const d = pi.transfer_data?.destination;
  if (!d) return null;
  return typeof d === 'string' ? d : d.id;
}

/**
 * Create a destination-charge PaymentIntent on the platform that settles to the
 * tenant's connected account, minus the platform application fee. Used for the
 * hosted invoice Pay Now. Returns the client secret for Stripe.js.
 */
export async function createDestinationPaymentIntent(args: {
  amountCents: number;
  applicationFeeCents: number;
  destinationAccount: string;
  method: 'CARD' | 'ACH';
  metadata: Record<string, string>;
}): Promise<{ clientSecret: string; id: string }> {
  const stripe = getPlatformStripe();
  const pi = await stripe.paymentIntents.create({
    amount: args.amountCents,
    currency: 'usd',
    payment_method_types: args.method === 'ACH' ? ['us_bank_account'] : ['card'],
    application_fee_amount: args.applicationFeeCents > 0 ? args.applicationFeeCents : undefined,
    transfer_data: { destination: args.destinationAccount },
    metadata: args.metadata,
  });
  if (!pi.client_secret) throw new Error('Stripe did not return a client secret.');
  return { clientSecret: pi.client_secret, id: pi.id };
}

/** Verify and parse a Stripe webhook event from the raw request body. */
export function constructWebhookEvent(rawBody: string, signature: string): Stripe.Event {
  // Destination charges split events across TWO Stripe endpoints, and a Stripe
  // endpoint is either a platform endpoint or a Connect endpoint — never both:
  //
  //   platform endpoint  -> payment_intent.succeeded / .processing / .payment_failed
  //   Connect endpoint   -> payout.paid (fires on the connected account)
  //
  // Each endpoint has its own signing secret, so verification must try both.
  // A single-secret implementation silently 400s every event from the endpoint
  // whose secret it doesn't hold.
  const secrets = [
    process.env.STRIPE_WEBHOOK_SECRET,
    process.env.STRIPE_WEBHOOK_SECRET_CONNECT,
  ].filter((s): s is string => Boolean(s));

  if (secrets.length === 0) {
    throw new Error(
      'No Stripe webhook secret configured. Set STRIPE_WEBHOOK_SECRET (platform endpoint) ' +
        'and, if a Connect endpoint exists, STRIPE_WEBHOOK_SECRET_CONNECT.',
    );
  }

  const stripe = getPlatformStripe();
  let lastError: unknown;
  for (const secret of secrets) {
    try {
      return stripe.webhooks.constructEvent(rawBody, signature, secret);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Stripe webhook signature verification failed against every configured secret.');
}

/**
 * The Stripe processing fee actually charged on a PaymentIntent's charge, in
 * cents. On a destination charge this cost is borne by the platform, so it's
 * the platform's processing-cost expense. Returns null if not yet available.
 */
export async function getChargeProcessingFeeCents(paymentIntentId: string): Promise<number | null> {
  const stripe = getPlatformStripe();
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge.balance_transaction'] });
  const charge = pi.latest_charge;
  if (!charge || typeof charge === 'string') return null;
  const bt = charge.balance_transaction;
  if (!bt || typeof bt === 'string') return null;
  return typeof bt.fee === 'number' ? bt.fee : null;
}

/** Lightweight status read for a PaymentIntent (hosted-page return banner). */
export async function getPaymentIntentStatus(paymentIntentId: string): Promise<string | null> {
  try {
    const pi = await getPlatformStripe().paymentIntents.retrieve(paymentIntentId);
    return pi.status ?? null;
  } catch {
    return null;
  }
}
