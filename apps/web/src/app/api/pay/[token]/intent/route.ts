export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/server';

/**
 * POST /api/pay/[token]/intent — start a payment for the hosted invoice.
 *
 * This is the seam the Stripe Connect adapter fills in the payments package.
 * Until a tenant has a connected payment account, it returns a clean
 * { enabled:false } with a customer-friendly message — so the Pay Now UI is
 * fully functional and visible now, and only the charge itself waits on creds.
 *
 * No auth: this is the public customer payment path, keyed by the invoice's
 * unguessable public_token.
 */
export async function POST(req: Request, { params }: { params: { token: string } }) {
  const supabase = createAdminSupabase();

  const { data: inv } = await supabase
    .from('invoices')
    .select('id, org_id, balance_cents, status')
    .eq('public_token', params.token)
    .maybeSingle();

  if (!inv) return NextResponse.json({ enabled: false, message: 'This invoice link is no longer valid.' }, { status: 404 });
  if ((inv as { balance_cents: number }).balance_cents <= 0) {
    return NextResponse.json({ enabled: false, message: 'This invoice is already paid in full.' });
  }

  // Is a payment provider connected for this tenant? (core.provider_connections,
  // populated when the tenant links Stripe.) Until then, payments are not live.
  let providerReady = false;
  try {
    const { data: conn } = await supabase
      .schema('core').from('provider_connections')
      .select('id, status')
      .eq('org_id', (inv as { org_id: string }).org_id)
      .eq('capability', 'PAYMENTS')
      .eq('status', 'ACTIVE')
      .maybeSingle();
    providerReady = !!conn;
  } catch {
    providerReady = false; // table/column shape differences pre-payments-package
  }

  if (!providerReady) {
    return NextResponse.json({
      enabled: false,
      message: 'Online payment for this business is being set up. In the meantime, please pay using the remit-to details on this invoice.',
    });
  }

  // Provider IS connected → the Stripe adapter (payments package) creates the
  // PaymentIntent on the tenant's connected account and returns a client secret
  // / hosted redirect here. Stubbed until that package lands.
  return NextResponse.json({
    enabled: false,
    message: 'Payment is being initialized. Please try again in a moment.',
  });
}
