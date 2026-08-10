export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { listConnections } from '@/lib/money/connections';
import { createDestinationPaymentIntent } from '@/lib/money/providers/stripe';
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
 * invoice. Destination charge to the tenant's connected account; the platform
 * application fee is the spread. Returns the client secret for Stripe.js.
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
    .select('id, org_id, location_id, customer_id, balance_cents, status, card_surcharge_enabled, ach_surcharge_enabled')
    .eq('public_token', params.token)
    .maybeSingle();
  if (!inv) return NextResponse.json({ enabled: false, message: 'This invoice link is no longer valid.' }, { status: 404 });

  const i = inv as { id: string; org_id: string; location_id: string; customer_id: string; balance_cents: number; status: string; card_surcharge_enabled: boolean | null; ach_surcharge_enabled: boolean | null };
  if (i.balance_cents <= 0) return NextResponse.json({ enabled: false, message: 'This invoice is already paid in full.' });

  const conns = await listConnections(supabase, i.org_id);
  const conn = conns.find((c) => c.capability === 'AR_COLLECTION' && c.provider === 'stripe' && c.status === 'active' && c.accountHandle);
  if (!conn?.accountHandle) {
    return NextResponse.json({ enabled: false, message: 'Online payment for this business is being set up. Please use the remit-to details on this invoice.' });
  }

  const base = i.balance_cents;

  // Layer 1 — what MeritBooks charges this merchant for this payment. Read from
  // the merchant's fee schedule (falls back to the platform default), applying
  // the merchant's rate and any cap/floor. Replaces the old hardcoded 1%/3%.
  const schedule = await resolveMerchantFeeSchedule(supabase, i.org_id);
  const appFeeCents = computeFee(schedule, method, base);

  // Layer 2 — does the merchant pass this fee to the customer, or absorb it?
  // Defaults asymmetric by method: card passes through, ACH is absorbed. Invoice
  // level is the most-specific override honoured here.
  const passThrough =
    appFeeCents > 0 &&
    (method === 'CARD'
      ? i.card_surcharge_enabled !== false // card: pass-through unless explicitly off
      : i.ach_surcharge_enabled === true); // ACH: absorbed unless explicitly on

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
      destinationAccount: conn.accountHandle,
      method,
      metadata: {
        invoice_id: i.id, org_id: i.org_id, location_id: i.location_id ?? '',
        customer_id: i.customer_id ?? '', token: params.token,
        base_cents: String(base), amount_cents: String(amountCents), app_fee_cents: String(appFeeCents),
        method,
      },
    });
    await recordInvoiceEvent(supabase, { orgId: i.org_id, invoiceId: i.id, type: 'PAY_INITIATED', actor: 'customer', meta: { method, amount_cents: amountCents, pi: id } });
    return NextResponse.json({
      enabled: true,
      client_secret: clientSecret,
      publishable_key: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '',
      amount_cents: amountCents,
      fee_cents: appFeeCents,
    });
  } catch (e) {
    return NextResponse.json({ enabled: false, message: e instanceof Error ? e.message : 'Could not start the payment.' }, { status: 500 });
  }
}
