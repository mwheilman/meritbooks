export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { createDestinationPaymentIntent } from '@/lib/money/providers/stripe';
import { resolvePayDecision } from '@/lib/invoices/pay-link';
import { stripeCanCharge, stripeMode } from '@/lib/money/payments-mode';
import { recordInvoiceEvent } from '@/lib/invoices/invoice-events';
import { computeFee, resolveMerchantFeeSchedule } from '@/lib/money/fees';
import { sharedRateLimiter, clientIp, retryAfterSeconds } from '@/lib/security/rate-limit';

// Abuse throttle for this UNAUTHENTICATED endpoint — each call can create a Stripe
// PaymentIntent. Short window, per-token AND per-IP; a customer paying an invoice
// makes only a handful of attempts, a hostile client looping intents is capped.
const INTENT_PER_TOKEN = { windowMs: 60_000, max: 15 } as const;
const INTENT_PER_IP = { windowMs: 60_000, max: 30 } as const;

/**
 * POST /api/pay/[token]/intent — create a Stripe PaymentIntent for the hosted
 * invoice. Destination charge to the connected account of the COMPANY that issued
 * the invoice (migration 175 — falls back to the tenant-level account only when the
 * tenant opted into "one account for all companies"); the platform application fee
 * is the spread. Returns the client secret for Stripe.js.
 *
 * The connected account is resolved here from the invoice — never accepted from the
 * caller. The method must be allowed by the invoice → job → customer → company
 * cascade (refused server-side, not just hidden on the page). Only connections of the
 * environment the server key belongs to (test vs live) are ever used.
 *
 * The invoice total never changes. ACH/absorbed-card charge the balance; a
 * passed-through card surcharge is added to the amount charged only.
 */
export async function POST(req: Request, { params }: { params: { token: string } }) {
  // Throttle BEFORE the invoice lookup / any Stripe call. Per-token AND per-IP;
  // either breach returns 429 so a hostile client cannot spam PaymentIntent creation.
  const ip = clientIp(req);
  const throttle = sharedRateLimiter.checkAll([
    { key: `pay-intent:token:${params.token}`, rule: INTENT_PER_TOKEN },
    { key: `pay-intent:ip:${ip}`, rule: INTENT_PER_IP },
  ]);
  if (!throttle.allowed) {
    return NextResponse.json(
      { enabled: false, message: 'Too many payment attempts in a short time. Please wait a moment and try again.' },
      { status: 429, headers: { 'Retry-After': String(retryAfterSeconds(throttle)) } },
    );
  }

  const supabase = createAdminSupabase();
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const method: 'CARD' | 'ACH' = body.method === 'CARD' ? 'CARD' : 'ACH';
  const acceptFee = body.accept_fee === true;

  const { data: inv } = await supabase
    .from('invoices')
    .select('id, org_id, location_id, customer_id, job_id, balance_cents, status, payment_methods_allowed, card_surcharge_enabled, ach_surcharge_enabled')
    .eq('public_token', params.token)
    .maybeSingle();
  if (!inv) return NextResponse.json({ enabled: false, message: 'This invoice link is no longer valid.' }, { status: 404 });

  const i = inv as {
    id: string; org_id: string; location_id: string; customer_id: string; job_id: string | null;
    balance_cents: number; status: string;
    payment_methods_allowed: string[] | null; card_surcharge_enabled: boolean | null; ach_surcharge_enabled: boolean | null;
  };
  if (i.balance_cents <= 0) return NextResponse.json({ enabled: false, message: 'This invoice is already paid in full.' });
  if (i.status === 'VOIDED' || i.status === 'WRITTEN_OFF' || i.status === 'DRAFT') {
    // A DRAFT was never issued (no A/R posted, terms can still change): never take money on it.
    return NextResponse.json({ enabled: false, message: 'This invoice cannot be paid online. Please contact the sender.' });
  }

  const setUpMessage = 'Online payment for this business is being set up. Please use the remit-to details on this invoice.';
  if (!stripeCanCharge()) {
    // Keys missing or mismatched (e.g. live secret + test publishable): never guess.
    console.error('[pay intent] online payment unavailable:', stripeMode().state);
    return NextResponse.json({ enabled: false, message: setUpMessage });
  }

  // THE payability decision (lib/invoices/pay-link.ts) — the same one the pay page, PDF,
  // email and drawer show. Anything it says no to is refused here, not just hidden.
  const decision = await resolvePayDecision(supabase, i.org_id, {
    public_token: params.token, status: i.status, balance_cents: i.balance_cents,
    location_id: i.location_id, customer_id: i.customer_id, job_id: i.job_id,
    payment_methods_allowed: i.payment_methods_allowed,
    card_surcharge_enabled: i.card_surcharge_enabled, ach_surcharge_enabled: i.ach_surcharge_enabled,
  });
  const { state, terms } = decision;
  if (!state.payable || !decision.connection?.accountHandle) {
    const message = state.code === 'NOT_READY'
      ? 'Online payment for this business is paused. Please use the remit-to details on this invoice.'
      : state.code === 'NO_ONLINE_METHOD'
        ? 'Online payment is not accepted for this invoice. Please use the remit-to details on this invoice.'
        : setUpMessage;
    return NextResponse.json({ enabled: false, message }, { status: state.code === 'NO_ONLINE_METHOD' ? 409 : 200 });
  }
  // The method must be one the invoice is actually offered on (cascade ∩ account).
  if (!state.methods.includes(method)) {
    const label = method === 'CARD' ? 'Card payment' : 'Bank transfer';
    return NextResponse.json({ enabled: false, message: `${label} is not accepted for this invoice.` }, { status: 409 });
  }
  const conn = decision.connection;
  const pick = { source: decision.source };
  const destination = conn.accountHandle as string;

  const base = i.balance_cents;

  // Layer 1 — what MeritBooks charges this merchant for this payment. Read from
  // the merchant's fee schedule (falls back to the platform default), applying
  // the merchant's rate and any cap/floor. Replaces the old hardcoded 1%/3%.
  // (resolvePayDecision loaded one too, but falls back to the default for DISPLAY on a query
  // failure — re-read strictly here so a broken query never misprices a charge.)
  const strictSchedule = await resolveMerchantFeeSchedule(supabase, i.org_id);
  const appFeeCents = computeFee(strictSchedule, method, base);

  // Layer 2 — does the merchant pass this fee to the customer, or absorb it?
  // Defaults asymmetric by method: card passes through, ACH is absorbed; resolved
  // most-specific-wins over invoice → job → customer → company.
  const passThrough =
    appFeeCents > 0 && (method === 'CARD' ? terms.cardPassThrough : terms.achPassThrough);

  if (passThrough && !acceptFee) {
    const label = method === 'CARD' ? 'card' : 'bank transfer';
    return NextResponse.json({ enabled: false, message: `Please accept the ${label} processing fee to continue.` });
  }

  // Pass-through adds the fee to what the customer is charged (invoice total is
  // immutable); absorbed leaves the charge at base and the merchant nets base − fee.
  const amountCents = passThrough ? base + appFeeCents : base;

  try {
    const { clientSecret, id } = await createDestinationPaymentIntent({
      amountCents,
      applicationFeeCents: appFeeCents,
      destinationAccount: destination,
      method,
      metadata: {
        invoice_id: i.id, org_id: i.org_id, location_id: i.location_id ?? '',
        customer_id: i.customer_id ?? '', token: params.token,
        base_cents: String(base), amount_cents: String(amountCents), app_fee_cents: String(appFeeCents),
        method,
        connection_id: conn.id, account_source: pick.source ?? '', environment: conn.environment,
      },
    });
    await recordInvoiceEvent(supabase, {
      orgId: i.org_id, invoiceId: i.id, type: 'PAY_INITIATED', actor: 'customer',
      meta: { method, amount_cents: amountCents, pi: id, connection_id: conn.id, account_source: pick.source, environment: conn.environment },
    });
    return NextResponse.json({
      enabled: true,
      client_secret: clientSecret,
      publishable_key: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '',
      amount_cents: amountCents,
      fee_cents: appFeeCents,
      // The payer sees whether this is a real charge (never "live" in test mode).
      test_mode: conn.environment !== 'live',
    });
  } catch (e) {
    // The caller is unauthenticated: never echo provider / internal error text (it can carry
    // account ids, request ids or configuration detail). Log it server-side, answer generically.
    const err = e as { type?: string; code?: string; statusCode?: number; message?: string };
    console.error('[pay intent] could not create the PaymentIntent', {
      invoice_id: i.id, method, type: err?.type, code: err?.code, statusCode: err?.statusCode, message: err?.message,
    });
    return NextResponse.json(
      { enabled: false, message: 'We could not start the payment just now. Please try again in a few minutes, or use the remit-to details on this invoice.' },
      { status: 502 },
    );
  }
}
