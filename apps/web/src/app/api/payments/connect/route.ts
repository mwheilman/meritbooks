export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { apiHandler, type ApiContext } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/server';
import { requirePermission } from '@/lib/rbac/require-permission';
import { assertWriteScope, isWriteScopeError } from '@/lib/db/scoped-writer';
import { listConnections, connectProvider } from '@/lib/money/connections';
import { createConnectedAccount, createDashboardLink, createOnboardingLink } from '@/lib/money/providers/stripe';
import { getAccountMode, writeAudit } from '@/lib/money/payment-accounts';
import { stripeConnectionEnv, stripeMode } from '@/lib/money/payments-mode';
import { paymentsConnectBody, type PaymentsConnectBody } from '@/lib/validations/payments';
import { recordSettlementChange, requireSettlementAuthority } from '@/lib/money/settlement-guard';

function baseUrl(req: Request): string {
  return process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin;
}

/**
 * POST /api/payments/connect  { location_id, intent }
 *
 * Start / continue Stripe setup for ONE company (migration 175 — each company gets its own
 * Stripe Express account, so its customers' payments settle to its own bank), or open
 * that company's Stripe dashboard. Returns a Stripe-hosted URL.
 *
 * - The environment is the one the server key belongs to (sk_test_ → test, sk_live_ →
 *   live); a test account is never reused under a live key.
 * - location_id null = the tenant-level account, allowed only in "one account for all
 *   companies" mode.
 * - The connected-account id is created / looked up here; it is never accepted from the
 *   browser. Requires settings_system:edit; the company must be in the caller's scope.
 * - Stripe onboarding and the Stripe dashboard are where the payout bank is set, so both
 *   also require the money-movement release authority (lib/money/settlement-guard), and
 *   opening either notifies the tenant owner(s) and is action-logged.
 */
export function POST(req: Request) {
  return apiHandler(paymentsConnectBody, (body, ctx) => connect(body, ctx, baseUrl(req)))(req);
}

async function connect(body: PaymentsConnectBody, ctx: ApiContext, origin: string): Promise<NextResponse> {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  // Connecting provisions a Stripe account and flips a money-movement entitlement.
  const guard = await requirePermission(ctx.userId, 'settings_system', 'edit');
  if (!guard.ok) return guard.response;
  const orgId = guard.orgId;
  // Where the money settles (the payout bank) is money movement.
  const money = await requireSettlementAuthority(ctx.userId);
  if (!money.ok) return money.response;

  const env = stripeConnectionEnv();
  const sm = stripeMode();
  if (!env || sm.state === 'not_configured' || sm.state === 'unrecognized_key') {
    return NextResponse.json({ error: sm.problem ?? 'Stripe is not set up on the server.', code: 'STRIPE_NOT_CONFIGURED' }, { status: 400 });
  }

  const locationId = body.location_id ?? null;
  const admin = createAdminSupabase();
  let companyName: string | null = null;
  if (locationId) {
    try {
      await assertWriteScope(ctx.supabase, orgId, [locationId]);
    } catch (e) {
      if (isWriteScopeError(e)) return NextResponse.json({ error: e.message, code: 'FORBIDDEN' }, { status: 403 });
      throw e;
    }
    const { data: loc } = await admin.schema('core').from('locations').select('name').eq('org_id', orgId).eq('id', locationId).maybeSingle<{ name: string }>();
    companyName = loc?.name ?? null;
  } else if ((await getAccountMode(admin, orgId)) !== 'single') {
    return NextResponse.json({ error: 'Choose the company to connect. Each company collects into its own Stripe account.', code: 'COMPANY_REQUIRED' }, { status: 422 });
  }

  // Entitlement must be set before connectProvider will register the connection.
  // core.organizations is SELECT-only for members (migration 154) — flipped as the
  // service role, gated by settings_system:edit above and pinned to the guard's org.
  const { data: orgRow } = await admin.schema('core').from('organizations').select('entitlements').eq('id', orgId).maybeSingle<{ entitlements: Record<string, boolean> | null }>();
  const entitlements = orgRow?.entitlements && typeof orgRow.entitlements === 'object' ? orgRow.entitlements : {};
  if (entitlements['ar_collection'] !== true) {
    await admin.schema('core').from('organizations').update({ entitlements: { ...entitlements, ar_collection: true } }).eq('id', orgId);
  }

  const existing = (await listConnections(admin, orgId)).find(
    (c) => c.capability === 'AR_COLLECTION' && c.provider === 'stripe' && c.environment === env && c.locationId === locationId && !!c.accountHandle,
  );

  try {
    let accountId = existing?.accountHandle ?? null;
    let connectionId = existing?.id ?? null;
    if (!accountId) {
      accountId = await createConnectedAccount({
        businessName: companyName,
        metadata: { org_id: orgId, location_id: locationId ?? '', created_by: ctx.userId },
      });
      // core.provider_connections is SELECT-only for members (migration 171): written by
      // the service role after the checks above, pinned to the guard's org.
      const conn = await connectProvider(admin, orgId, {
        capability: 'AR_COLLECTION',
        provider: 'stripe',
        environment: env,
        locationId,
        accountHandle: accountId,
        connectedBy: ctx.userId,
        metadata: { company_name: companyName },
      });
      connectionId = conn.id;
      await writeAudit(admin, { orgId, table: 'provider_connections', recordId: conn.id, field: 'stripe_account', oldValue: null, newValue: `created (${env})`, userId: ctx.userId, action: 'INSERT' });
    }

    const who = companyName ?? 'all companies (single account)';
    const day = new Date().toISOString().slice(0, 10);
    if (body.intent === 'dashboard' && existing?.account.detailsSubmitted) {
      const url = await createDashboardLink(accountId);
      await recordSettlementChange(admin, {
        orgId, actorUserId: ctx.userId, action: 'payments.stripe.dashboard_opened',
        title: 'Stripe payout settings opened',
        body: `A team member opened the Stripe dashboard for ${who}, where the payout bank account can be changed.`,
        locationId, subjectTable: 'provider_connections', subjectId: connectionId ?? accountId,
        dedupeKey: `stripe-dash:${ctx.userId}:${locationId ?? 'tenant'}:${day}`,
      });
      return NextResponse.json({ url });
    }

    const q = locationId ? `?company=${encodeURIComponent(locationId)}` : '';
    const url = await createOnboardingLink(
      accountId,
      `${origin}/settings/payments/refresh${q}`,
      `${origin}/settings/payments/return${q}`,
    );
    if (connectionId) {
      await writeAudit(admin, { orgId, table: 'provider_connections', recordId: connectionId, field: 'stripe_onboarding', oldValue: null, newValue: 'link opened', userId: ctx.userId });
    }
    await recordSettlementChange(admin, {
      orgId, actorUserId: ctx.userId, action: existing ? 'payments.stripe.onboarding_opened' : 'payments.stripe.account_created',
      title: existing ? 'Stripe payout setup reopened' : 'New Stripe payout account started',
      body: existing
        ? `A team member reopened Stripe setup for ${who}, where the payout bank account is entered.`
        : `A team member started a new Stripe account for ${who}. Customer payments will settle to the bank account entered there.`,
      locationId, subjectTable: 'provider_connections', subjectId: connectionId ?? accountId,
      dedupeKey: existing ? `stripe-onb:${ctx.userId}:${locationId ?? 'tenant'}:${day}` : null,
    });
    return NextResponse.json({ url });
  } catch (e) {
    const err = e as { type?: string; code?: string; statusCode?: number; message?: string };
    console.error('[payments/connect] stripe error', { type: err.type, code: err.code, statusCode: err.statusCode, message: err.message });
    return NextResponse.json({ error: 'Stripe could not start setup right now. Try again in a minute.', code: 'STRIPE_ERROR' }, { status: 502 });
  }
}
