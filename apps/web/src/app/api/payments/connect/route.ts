export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { listConnections, connectProvider } from '@/lib/money/connections';
import {
  isStripeConfigured,
  createConnectedAccount,
  createOnboardingLink,
  getConnectedAccountStatus,
} from '@/lib/money/providers/stripe';

const ENV = 'test' as const; // sandbox until live keys are swapped in

type Supa = ReturnType<typeof createAdminSupabase>;
async function getOrg(db: Supa): Promise<{ id: string; entitlements: Record<string, boolean> } | null> {
  const { data } = await db.schema('core').from('organizations').select('id, entitlements').limit(1).single();
  if (!data) return null;
  const d = data as { id: string; entitlements?: unknown };
  return { id: d.id, entitlements: (d.entitlements && typeof d.entitlements === 'object' ? d.entitlements : {}) as Record<string, boolean> };
}

async function findStripeArConnection(db: Supa, orgId: string) {
  const conns = await listConnections(db, orgId);
  return conns.find((c) => c.capability === 'AR_COLLECTION' && c.provider === 'stripe' && c.environment === ENV) ?? null;
}

function baseUrl(req: Request): string {
  return process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin;
}

/** GET — current payments-connect status for the settings screen. */
export async function GET(req: Request) {
  await auth().catch(() => null);
  if (!isStripeConfigured()) {
    return NextResponse.json({ configured: false, message: 'Stripe is not configured on the server (set STRIPE_SECRET_KEY).' });
  }
  const db = createAdminSupabase();
  const org = await getOrg(db);
  if (!org) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const conn = await findStripeArConnection(db, org.id);
  if (!conn?.accountHandle) {
    return NextResponse.json({ configured: true, connected: false, status: 'not_started' });
  }
  try {
    const s = await getConnectedAccountStatus(conn.accountHandle);
    const ready = s.chargesEnabled && s.detailsSubmitted;
    return NextResponse.json({
      configured: true,
      connected: true,
      accountHandle: conn.accountHandle,
      status: ready ? 'active' : 'pending',
      chargesEnabled: s.chargesEnabled,
      payoutsEnabled: s.payoutsEnabled,
      detailsSubmitted: s.detailsSubmitted,
    });
  } catch (e) {
    return NextResponse.json({ configured: true, connected: true, status: 'error', message: e instanceof Error ? e.message : 'Stripe error' });
  }
}

/** POST — start or resume onboarding; returns the Stripe-hosted onboarding URL. */
export async function POST(req: Request) {
  const { userId } = await auth().catch(() => ({ userId: null as string | null }));
  if (!isStripeConfigured()) {
    return NextResponse.json({ error: 'Stripe is not configured on the server (set STRIPE_SECRET_KEY).' }, { status: 400 });
  }
  const db = createAdminSupabase();
  const org = await getOrg(db);
  if (!org) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  // Entitlement must be set before connectProvider will register the connection.
  if (org.entitlements['ar_collection'] !== true) {
    await db.schema('core').from('organizations')
      .update({ entitlements: { ...org.entitlements, ar_collection: true } })
      .eq('id', org.id);
  }

  // Reuse an existing connected account, or create a new one.
  let conn = await findStripeArConnection(db, org.id);
  let accountId = conn?.accountHandle ?? null;
  try {
    if (!accountId) {
      accountId = await createConnectedAccount(null);
      await connectProvider(db, org.id, {
        capability: 'AR_COLLECTION',
        provider: 'stripe',
        environment: ENV,
        accountHandle: accountId,
        connectedBy: userId ?? 'system',
      });
    }

    const root = baseUrl(req);
    const url = await createOnboardingLink(
      accountId,
      `${root}/settings/payments/refresh`,
      `${root}/settings/payments/return`,
    );
    return NextResponse.json({ url });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Stripe error' }, { status: 500 });
  }
}
