export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { createAdminSupabase } from '@/lib/supabase/server';
import { constructWebhookEvent, getChargeProcessingFeeCents } from '@/lib/money/providers/stripe';
import { applyStripePaymentToInvoice } from '@/lib/money/apply-invoice-payment';
import { postArPayout } from '@/lib/money/posting/ar-posting';
import { postPlatformFee } from '@/lib/money/posting/platform-fee';
import { recordInvoiceEvent } from '@/lib/invoices/invoice-events';

/**
 * POST /api/webhooks/stripe — Stripe Connect event endpoint.
 * Verifies the signature, dedupes on event id, and reacts to payment + payout
 * events. Source of truth for marking invoices paid (not the browser redirect).
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

  // Idempotency — record the event id; skip if already seen.
  const { error: dupeErr } = await db.from('stripe_events').insert({ id: event.id, type: event.type });
  if (dupeErr) return NextResponse.json({ received: true, duplicate: true });

  try {
    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object as Stripe.PaymentIntent;
      const m = pi.metadata ?? {};
      if (m.invoice_id && m.org_id) {
        await applyStripePaymentToInvoice(db, {
          orgId: m.org_id, invoiceId: m.invoice_id, locationId: m.location_id ?? '',
          customerId: m.customer_id ?? '',
          baseCents: Number(m.base_cents ?? pi.amount),
          amountCents: Number(m.amount_cents ?? pi.amount),
          appFeeCents: Number(m.app_fee_cents ?? 0),
          method: m.method === 'CARD' ? 'CARD' : 'ACH',
          piId: pi.id,
        });

        // Book the application fee as income on the platform operator's own
        // ledger (Merit-as-platform). Gated on PLATFORM_ORG_ID; no-op otherwise.
        const platformOrgId = process.env.PLATFORM_ORG_ID;
        const grossFeeCents = Number(m.app_fee_cents ?? 0);
        if (platformOrgId && grossFeeCents > 0 && platformOrgId !== m.org_id) {
          try {
            const { data: loc } = await db.schema('core').from('locations')
              .select('id').eq('org_id', platformOrgId).limit(1).maybeSingle();
            const platformLocationId = (loc as { id: string } | null)?.id;
            if (platformLocationId) {
              let stripeCostCents = 0;
              try {
                const fee = await getChargeProcessingFeeCents(pi.id);
                if (fee != null) stripeCostCents = Math.min(fee, grossFeeCents);
              } catch { /* fall back to gross-only if the fee isn't retrievable */ }
              await postPlatformFee(db, {
                platformOrgId, locationId: platformLocationId,
                entryDate: new Date().toISOString().slice(0, 10),
                grossFeeCents, stripeCostCents,
                createdBy: null, sourceId: pi.id, sourceTenantOrgId: m.org_id,
              });
            }
          } catch (e) {
            console.error('[stripe webhook] platform fee posting failed', pi.id, e);
          }
        }
      }
    } else if (event.type === 'payment_intent.payment_failed') {
      const pi = event.data.object as Stripe.PaymentIntent;
      const m = pi.metadata ?? {};
      if (m.invoice_id && m.org_id) {
        await recordInvoiceEvent(db, {
          orgId: m.org_id, invoiceId: m.invoice_id, type: 'PAY_FAILED', actor: 'customer',
          meta: { pi: pi.id, reason: pi.last_payment_error?.message ?? 'failed' },
        });
      }
    } else if (event.type === 'payout.paid') {
      const payout = event.data.object as Stripe.Payout;
      const acct = (event.account as string) ?? null; // connected account id
      if (acct) {
        const { data: conn } = await db.schema('core').from('provider_connections')
          .select('org_id').eq('account_handle', acct).eq('capability', 'AR_COLLECTION').maybeSingle();
        const orgId = (conn as { org_id: string } | null)?.org_id;
        if (orgId) {
          const { data: loc } = await db.schema('core').from('locations').select('id').eq('org_id', orgId).limit(1).maybeSingle();
          const locationId = (loc as { id: string } | null)?.id;
          if (locationId) {
            await postArPayout(db, {
              orgId, locationId, entryDate: new Date().toISOString().slice(0, 10),
              payoutCents: payout.amount, createdBy: null, sourceId: payout.id,
            });
          }
        }
      }
    }
  } catch (e) {
    console.error('[stripe webhook] handler error', event.type, e);
    return NextResponse.json({ received: true, error: 'handler_error' });
  }

  return NextResponse.json({ received: true });
}
