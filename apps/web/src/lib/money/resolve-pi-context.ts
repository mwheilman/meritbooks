import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';

/**
 * The normalized payment context every payment_intent.* handler needs. Amounts
 * are bigint cents. `baseCents` is the A/R to relieve (the invoice's outstanding
 * balance), NOT the amount charged — a passed-through surcharge is charged to the
 * customer but never relieves A/R.
 */
export interface PiPaymentContext {
  orgId: string;
  invoiceId: string;
  locationId: string;
  customerId: string;
  baseCents: number;
  amountCents: number;   // amount actually charged (base + any pass-through fee)
  appFeeCents: number;   // platform application fee
  method: 'CARD' | 'ACH';
  source: 'metadata' | 'events';
}

/**
 * Resolve the invoice + amounts for a PaymentIntent, from the PaymentIntent id.
 *
 * Primary source is the PI's own metadata, which our intent route stamps at
 * creation (invoice_id, org_id, base/amount/app_fee cents, method). That is the
 * authoritative, locked path.
 *
 * FALLBACK — if metadata is ever absent (Stripe's per-key limits, a PI created
 * outside our flow, a future SDK change), we recover the invoice from the PI id
 * via the PAY_INITIATED lifecycle event our intent route wrote (its meta.pi ==
 * the PI id), then take amounts from the invoice + the PI object itself. Without
 * this, a "succeeded" event whose metadata went missing would be silently 200'd
 * to Stripe and NEVER post to the ledger — the exact invisible-drop failure the
 * webhook guards against everywhere else.
 *
 * Returns null only when the invoice genuinely cannot be identified. The caller
 * must fail LOUD on null for money-bearing events (never a quiet success).
 */
export async function resolvePiPaymentContext(
  db: SupabaseClient,
  pi: Stripe.PaymentIntent,
): Promise<PiPaymentContext | null> {
  const m = pi.metadata ?? {};
  const piAmount = typeof pi.amount === 'number' ? pi.amount : 0;
  const piAppFee = typeof pi.application_fee_amount === 'number' ? pi.application_fee_amount : 0;

  // ---- Primary: PI metadata (authoritative, set by our intent route) --------
  if (m.invoice_id && m.org_id) {
    return {
      orgId: m.org_id,
      invoiceId: m.invoice_id,
      locationId: m.location_id ?? '',
      customerId: m.customer_id ?? '',
      baseCents: Number(m.base_cents ?? piAmount),
      amountCents: Number(m.amount_cents ?? piAmount),
      appFeeCents: Number(m.app_fee_cents ?? piAppFee),
      method: m.method === 'CARD' ? 'CARD' : 'ACH',
      source: 'metadata',
    };
  }

  // ---- Fallback: recover the invoice from the PI id via PAY_INITIATED --------
  const { data: initEvt } = await db
    .from('invoice_events')
    .select('org_id, invoice_id, meta')
    .eq('event_type', 'PAY_INITIATED')
    .eq('meta->>pi', pi.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!initEvt) return null;

  const evt = initEvt as { org_id: string; invoice_id: string; meta: Record<string, unknown> | null };

  // Read the live invoice for the location/customer and the outstanding balance.
  // baseCents = current balance (the A/R still owed): correct even if partial
  // payments have moved the balance since the intent was created.
  const { data: invRow } = await db
    .from('invoices')
    .select('location_id, customer_id, balance_cents')
    .eq('org_id', evt.org_id)
    .eq('id', evt.invoice_id)
    .maybeSingle();
  if (!invRow) return null;

  const inv = invRow as { location_id: string | null; customer_id: string | null; balance_cents: number };
  const metaMethod = String((evt.meta ?? {}).method ?? '');

  return {
    orgId: evt.org_id,
    invoiceId: evt.invoice_id,
    locationId: inv.location_id ?? '',
    customerId: inv.customer_id ?? '',
    baseCents: Number(inv.balance_cents ?? 0),
    amountCents: piAmount,
    appFeeCents: piAppFee,
    method: metaMethod === 'CARD' ? 'CARD' : 'ACH',
    source: 'events',
  };
}
