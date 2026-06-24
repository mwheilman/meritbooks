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

/** Create a new Express connected account for a tenant. Returns the acct_ id. */
export async function createConnectedAccount(email?: string | null): Promise<string> {
  const stripe = getPlatformStripe();
  const account = await stripe.accounts.create({
    type: 'express',
    email: email ?? undefined,
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
      us_bank_account_ach_payments: { requested: true },
    },
    business_type: undefined,
  });
  return account.id;
}

/** Create a hosted onboarding link the tenant completes to activate their account. */
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

export interface ConnectedAccountStatus {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}

/** Current onboarding/capability status for a connected account. */
export async function getConnectedAccountStatus(accountId: string): Promise<ConnectedAccountStatus> {
  const stripe = getPlatformStripe();
  const a = await stripe.accounts.retrieve(accountId);
  return {
    chargesEnabled: !!a.charges_enabled,
    payoutsEnabled: !!a.payouts_enabled,
    detailsSubmitted: !!a.details_submitted,
  };
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
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not set in the environment.');
  return getPlatformStripe().webhooks.constructEvent(rawBody, signature, secret);
}
