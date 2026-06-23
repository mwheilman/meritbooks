export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { listConnections } from '@/lib/money/connections';
import { createDestinationPaymentIntent } from '@/lib/money/providers/stripe';
import { recordInvoiceEvent } from '@/lib/invoices/invoice-events';

const CARD_PCT = 0.03; // 3% flat (de minimis loss under the market cap)
const ACH_PCT = 0.01;  // 1%, mirrors QuickBooks (no cap)

/**
 * POST /api/pay/[token]/intent — create a Stripe PaymentIntent for the hosted
 * invoice. Destination charge to the tenant's connected account; the platform
 * application fee is the spread. Returns the client secret for Stripe.js.
 *
 * The invoice total never changes. ACH/absorbed-card charge the balance; a
 * passed-through card surcharge is added to the amount charged only.
 */
export async function POST(req: Request, { params }: { params: { token: string } }) {
  const supabase = createAdminSupabase();
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const method: 'CARD' | 'ACH' = body.method === 'CARD' ? 'CARD' : 'ACH';
  const acceptFee = body.accept_fee === true;

  const { data: inv } = await supabase
    .from('invoices')
    .select('id, org_id, location_id, customer_id, balance_cents, status, card_surcharge_enabled')
    .eq('public_token', params.token)
    .maybeSingle();
  if (!inv) return NextResponse.json({ enabled: false, message: 'This invoice link is no longer valid.' }, { status: 404 });

  const i = inv as { id: string; org_id: string; location_id: string; customer_id: string; balance_cents: number; status: string; card_surcharge_enabled: boolean | null };
  if (i.balance_cents <= 0) return NextResponse.json({ enabled: false, message: 'This invoice is already paid in full.' });

  const conns = await listConnections(supabase, i.org_id);
  const conn = conns.find((c) => c.capability === 'AR_COLLECTION' && c.provider === 'stripe' && c.status === 'active' && c.accountHandle);
  if (!conn?.accountHandle) {
    return NextResponse.json({ enabled: false, message: 'Online payment for this business is being set up. Please use the remit-to details on this invoice.' });
  }

  const base = i.balance_cents;
  const surchargePass = method === 'CARD' && (i.card_surcharge_enabled !== false);
  let amountCents = base;
  let appFeeCents = 0;
  if (method === 'ACH') {
    appFeeCents = Math.round(base * ACH_PCT);
  } else if (surchargePass) {
    if (!acceptFee) return NextResponse.json({ enabled: false, message: 'Please accept the card processing fee to continue.' });
    appFeeCents = Math.round(base * CARD_PCT);
    amountCents = base + appFeeCents; // surcharge added to the amount charged, not the invoice
  } else {
    appFeeCents = Math.round(base * CARD_PCT); // absorbed by the business
  }

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
