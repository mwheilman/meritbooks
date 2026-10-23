export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { createAdminSupabase } from '@/lib/supabase/server';
import { accountDetailsFromObject, constructWebhookEvent, destinationOf, type StripeAccountLike } from '@/lib/money/providers/stripe';
import { applyAccountDetails, findConnectionByAccount, payoutLocationFor } from '@/lib/money/payment-accounts';
import { listConnections } from '@/lib/money/connections';
import { applyStripePaymentToInvoice } from '@/lib/money/apply-invoice-payment';
import { postArPayout } from '@/lib/money/posting/ar-posting';
import { recordInvoiceEvent } from '@/lib/invoices/invoice-events';
import { resolvePiPaymentContext } from '@/lib/money/resolve-pi-context';

/**
 * POST /api/webhooks/stripe — Stripe Connect event endpoint.
 * Verifies the signature, dedupes on event id, and reacts to payment + payout
 * events. Source of truth for marking invoices paid (not the browser redirect).
 *
 * Per-company routing (migration 175): Connect events (payout.paid, account.updated)
 * carry the connected account id (`event.account`, set by Stripe — signed, never from a
 * browser); it resolves to the connection and therefore the COMPANY, so a payout posts
 * on the company whose bank received it. payment_intent.* events resolve through the
 * invoice (metadata / PAY_INITIATED trail) exactly as before; the destination account is
 * cross-checked against the invoice's company and a mismatch is logged loudly.
 */
export async function POST(req: Request) {
  const sig = req.headers.get('stripe-signature');
  if (!sig) return NextResponse.json({ error: 'Missing signature' }, { status: 400 });

  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = constructWebhookEvent(raw, sig);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Invalid signature' }, { status: 400 });
  }

  const db = createAdminSupabase();

  // Idempotency — claim the event id before processing so concurrent
  // redeliveries can't double-post. Only a unique violation (23505) means we
  // have genuinely seen this event. Any OTHER insert error (table missing, RLS,
  // transient connection) must NOT be treated as a duplicate: doing so returns
  // 200 OK to Stripe while silently dropping the payment, which looks perfectly
  // healthy in Recent Deliveries and never posts to the ledger.
  const { error: dupeErr } = await db.from('stripe_events').insert({ id: event.id, type: event.type });
  if (dupeErr) {
    if (dupeErr.code === '23505') {
      return NextResponse.json({ received: true, duplicate: true });
    }
    console.error('[stripe webhook] idempotency store unavailable', event.id, event.type, dupeErr);
    // 500 → Stripe retries with backoff. Never 200 on an unverified claim.
    return NextResponse.json({ error: 'idempotency_store_unavailable' }, { status: 500 });
  }

  try {
    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object as Stripe.PaymentIntent;
      const ctx = await resolvePiPaymentContext(db, pi);
      if (!ctx) {
        // A payment SUCCEEDED at Stripe but we cannot identify its invoice from
        // the PI id (no metadata, no PAY_INITIATED trail). Retrying will not
        // recover missing data, so we do not 500-loop — but we must NEVER treat
        // this as a clean success: log LOUD for manual reconciliation.
        console.error('[stripe webhook] CRITICAL: succeeded PI could not be routed to an invoice', pi.id, event.id);
      } else {
        await crossCheckDestination(db, pi, ctx.orgId, ctx.locationId);
        await applyStripePaymentToInvoice(db, {
          orgId: ctx.orgId, invoiceId: ctx.invoiceId, locationId: ctx.locationId,
          customerId: ctx.customerId,
          baseCents: ctx.baseCents,
          amountCents: ctx.amountCents,
          appFeeCents: ctx.appFeeCents,
          method: ctx.method,
          piId: pi.id,
        });

        // NOTE: MeritBooks does NOT post platform-fee income onto any tenant's GL
        // via code (owner decision). With a destination charge the application fee
        // pays out to the platform operator's OWN Stripe balance / bank; if that
        // operator keeps books in MeritBooks, the resulting bank deposit is booked
        // as Payment Processing Income (4910) through normal AI bank-feed
        // categorization — no special code, no hardcoded platform-org pointer.
        // The realized application fee is still persisted per payment (app_fee_cents
        // + fee_rail on the PAY_SUCCEEDED invoice_event, written by
        // applyStripePaymentToInvoice) so the Operator Console can report fee
        // revenue without a GL post.
      }
    } else if (event.type === 'payment_intent.processing') {
      // ACH sits in `processing` for 1-2 business days before succeeding. Record
      // it so the ISSUER can see money is in flight — otherwise the invoice looks
      // identical to one the customer never touched. Informational only: no status
      // change and no GL posting, because the funds have not settled.
      const pi = event.data.object as Stripe.PaymentIntent;
      const ctx = await resolvePiPaymentContext(db, pi);
      if (ctx) {
        await recordInvoiceEvent(db, {
          orgId: ctx.orgId, invoiceId: ctx.invoiceId, type: 'PAY_PROCESSING', actor: 'customer',
          meta: {
            pi: pi.id,
            method: ctx.method,
            amount_cents: ctx.amountCents,
            expected_settlement: 'ACH transfers typically clear in 1-2 business days',
          },
        });
      }
    } else if (event.type === 'payment_intent.payment_failed') {
      const pi = event.data.object as Stripe.PaymentIntent;
      const ctx = await resolvePiPaymentContext(db, pi);
      if (ctx) {
        await recordInvoiceEvent(db, {
          orgId: ctx.orgId, invoiceId: ctx.invoiceId, type: 'PAY_FAILED', actor: 'customer',
          meta: { pi: pi.id, reason: pi.last_payment_error?.message ?? 'failed' },
        });
      }
    } else if (event.type === 'payout.paid') {
      const payout = event.data.object as Stripe.Payout;
      const acct = (event.account as string) ?? null; // connected account id (signed by Stripe)
      if (acct) {
        const owner = await findConnectionByAccount(db, acct);
        if (!owner) {
          console.error('[stripe webhook] payout from an unknown connected account — not posted', acct, event.id);
        } else {
          // Per-company account → that company; a tenant-level account (single mode) →
          // the tenant's first company, as before.
          const locationId = await payoutLocationFor(db, owner);
          if (locationId) {
            await postArPayout(db, {
              orgId: owner.orgId, locationId, entryDate: new Date().toISOString().slice(0, 10),
              payoutCents: payout.amount, createdBy: null, sourceId: payout.id,
            });
          }
        }
      }
    } else if (event.type === 'account.updated') {
      // Connect endpoint: onboarding progress, capability changes, payout bank changes.
      const acct = (event.account as string) ?? (event.data.object as { id?: string }).id ?? null;
      const owner = acct ? await findConnectionByAccount(db, acct) : null;
      if (owner) {
        const conn = (await listConnections(db, owner.orgId)).find((c) => c.id === owner.connectionId);
        if (conn) {
          await applyAccountDetails(db, conn, accountDetailsFromObject(event.data.object as unknown as StripeAccountLike), 'stripe');
        }
      }
    }
  } catch (e) {
    console.error('[stripe webhook] handler error', event.type, event.id, e);
    // The idempotency row was claimed before processing. Processing failed, so
    // release the claim — otherwise the retry is rejected as a duplicate and the
    // payment is permanently lost with no ledger entry and no error surfaced.
    const { error: releaseErr } = await db.from('stripe_events').delete().eq('id', event.id);
    if (releaseErr) {
      console.error('[stripe webhook] FAILED TO RELEASE idempotency claim — event will not be retried', event.id, releaseErr);
    }
    // 500 → Stripe retries. Returning 200 here would mark the event delivered.
    return NextResponse.json({ error: 'handler_error' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

/**
 * A destination charge must pay out to the account of the company that issued the
 * invoice. Our intent route guarantees it; if it ever doesn't (a PI created outside our
 * flow, a re-pointed connection), the payment is STILL applied — the receivable must be
 * relieved where it was booked — but it is logged loudly for reconciliation. Never throws.
 */
async function crossCheckDestination(
  db: ReturnType<typeof createAdminSupabase>,
  pi: Stripe.PaymentIntent,
  orgId: string,
  locationId: string,
): Promise<void> {
  try {
    const dest = destinationOf(pi as unknown as { transfer_data?: { destination?: string | { id: string } | null } | null });
    if (!dest) return;
    const owner = await findConnectionByAccount(db, dest);
    if (!owner || owner.orgId !== orgId || (owner.locationId !== null && owner.locationId !== locationId)) {
      console.error('[stripe webhook] CRITICAL: payment settled to a different company than the invoice', {
        pi: pi.id, destination: dest, invoiceOrg: orgId, invoiceLocation: locationId,
        accountOrg: owner?.orgId ?? null, accountLocation: owner?.locationId ?? null,
      });
    }
  } catch (e) {
    console.error('[stripe webhook] destination cross-check failed', pi.id, e);
  }
}
