/**
 * Settings → Payments read model (FPB-payments-fees §17.3): every company with its Stripe
 * account, payout bank, TEST/LIVE mode, accepted methods and who pays each fee — the one
 * shape the screen renders, so the screen never decides what "live" means.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { listConnections } from '@/lib/money/connections';
import { computeFee, resolveMerchantFeeSchedule, type MerchantFeeSchedule } from '@/lib/money/fees';
import {
  accountReadiness,
  disabledReasonText,
  getAccountMode,
  pickCollectionConnection,
  READINESS_LABEL,
  refreshAccountStatus,
  type AccountMode,
  type AccountReadiness,
  type CollectionSource,
} from '@/lib/money/payment-accounts';
import { companyPaymentOptions, type CompanyPaymentOptions, type TermsLevel } from '@/lib/money/payment-terms';
import { paymentsMode, stripeConnectionEnv, type KeyMode, type StripeModeState } from '@/lib/money/payments-mode';
import type { ProviderConnection } from '@/lib/money/providers/types';

export interface CompanyAccountView {
  readiness: AccountReadiness;
  readinessLabel: string;
  /** Where this company's payments go: its own account, the shared tenant account, or nowhere. */
  source: CollectionSource | null;
  /** 'live' only when the server key is live AND this account is ready. Otherwise 'test' or null. */
  modeBadge: 'LIVE' | 'TEST' | null;
  chargesEnabled: boolean | null;
  payoutsEnabled: boolean | null;
  payoutBank: { name: string | null; last4: string } | null;
  requirementsDueCount: number;
  /** Plain-English problem (never a Stripe code), or null. */
  problem: string | null;
  checkedAt: string | null;
  /** True once a Stripe account exists for this company (even if setup isn't finished). */
  hasAccount: boolean;
}

export interface CompanyPaymentsRow {
  locationId: string;
  name: string;
  shortCode: string | null;
  account: CompanyAccountView;
  options: CompanyPaymentOptions;
  /** Customers of this company can pay online right now. */
  acceptsOnline: boolean;
}

export interface FeeLine {
  method: 'CARD' | 'ACH';
  /** "3% per payment" / "1%, at most $10.00". */
  rate: string;
  /** Example fee on a $1,000 payment, in cents. */
  exampleOn100000: number;
}

export interface PaymentsOverview {
  stripe: {
    state: StripeModeState;
    mode: KeyMode | null;
    isLive: boolean;
    problem: string | null;
    webhookConfigured: boolean;
    connectWebhookConfigured: boolean;
  };
  plaid: { label: string; isLive: boolean; configured: boolean; warning: string | null };
  accountMode: AccountMode;
  /** The tenant-level account (used only in 'single' mode), if one exists in this environment. */
  tenantAccount: CompanyAccountView | null;
  fees: FeeLine[] | null;
  companies: CompanyPaymentsRow[];
  refreshedErrors: number;
}

function pct(bps: number): string {
  const v = bps / 100;
  return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(2).replace(/0$/, '')}%`;
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Layer-1 fee lines, read-only (what MeritBooks charges per payment). Pure. */
export function feeLines(s: MerchantFeeSchedule): FeeLine[] {
  const line = (method: 'CARD' | 'ACH', bps: number, cap: number | null, min: number | null): FeeLine => {
    const parts = [pct(bps)];
    if (cap != null) parts.push(`at most ${dollars(cap)}`);
    if (min != null) parts.push(`at least ${dollars(min)}`);
    return { method, rate: parts.join(', '), exampleOn100000: computeFee(s, method, 100_000) };
  };
  return [line('CARD', s.cardFeeBps, s.cardFeeCapCents, s.cardFeeMinCents), line('ACH', s.achFeeBps, s.achFeeCapCents, s.achFeeMinCents)];
}

/** The account view for one company (or the tenant account). Pure. */
export function accountView(conn: ProviderConnection | null, source: CollectionSource | null, keyIsLive: boolean): CompanyAccountView {
  const readiness = accountReadiness(conn);
  const a = conn?.account;
  const problem =
    readiness === 'restricted' ? disabledReasonText(a?.disabledReason ?? null) ?? 'Stripe needs more information before this company can take payments.'
    : readiness === 'setup_incomplete' ? 'Finish Stripe setup to start taking payments.'
    : readiness === 'ready' && a?.payoutsEnabled === false ? 'Payments are on, but Stripe has paused payouts to the bank.'
    : null;
  return {
    readiness,
    readinessLabel: READINESS_LABEL[readiness],
    source,
    modeBadge: conn ? (keyIsLive && conn.environment === 'live' && readiness === 'ready' ? 'LIVE' : 'TEST') : null,
    chargesEnabled: a?.chargesEnabled ?? null,
    payoutsEnabled: a?.payoutsEnabled ?? null,
    payoutBank: a?.payoutBankLast4 ? { name: a.payoutBankName, last4: a.payoutBankLast4 } : null,
    requirementsDueCount: a?.requirementsDue.length ?? 0,
    problem,
    checkedAt: a?.checkedAt ?? null,
    hasAccount: !!conn?.accountHandle,
  };
}

/** Refresh up to `limit` accounts at a time from Stripe; returns how many failed. */
async function refreshAll(adminDb: SupabaseClient, conns: ProviderConnection[], actor: string, limit = 4): Promise<number> {
  let failed = 0;
  for (let i = 0; i < conns.length; i += limit) {
    const batch = conns.slice(i, i + limit);
    const results = await Promise.allSettled(batch.map((c) => refreshAccountStatus(adminDb, c, actor)));
    failed += results.filter((r) => r.status === 'rejected').length;
  }
  return failed;
}

export async function buildPaymentsOverview(
  db: SupabaseClient,
  adminDb: SupabaseClient,
  orgId: string,
  opts: { refresh?: boolean; actor: string },
): Promise<PaymentsOverview> {
  const mode = paymentsMode();
  const env = stripeConnectionEnv();

  const [locRes, accountMode] = await Promise.all([
    db.schema('core').from('locations')
      .select('id, name, short_code, is_active, payment_methods_allowed, card_surcharge_enabled, ach_surcharge_enabled')
      .eq('org_id', orgId)
      .order('name', { ascending: true }),
    getAccountMode(db, orgId),
  ]);
  if (locRes.error) throw new Error(locRes.error.message);
  const locations = ((locRes.data ?? []) as Array<{ id: string; name: string; short_code: string | null; is_active: boolean | null } & TermsLevel>)
    .filter((l) => l.is_active !== false);

  let connections = await listConnections(db, orgId);
  const collection = (c: ProviderConnection) => c.capability === 'AR_COLLECTION' && c.provider === 'stripe' && c.status === 'active' && !!c.accountHandle && c.environment === env;

  let refreshedErrors = 0;
  if (opts.refresh && env && mode.stripe.state !== 'not_configured' && mode.stripe.state !== 'unrecognized_key') {
    refreshedErrors = await refreshAll(adminDb, connections.filter(collection), opts.actor);
    connections = await listConnections(db, orgId);
  }

  const keyIsLive = mode.stripe.isLive;
  const companies: CompanyPaymentsRow[] = locations.map((l) => {
    const pick = env ? pickCollectionConnection(connections, { locationId: l.id, mode: accountMode, environment: env }) : null;
    const view = accountView(pick?.connection ?? null, pick?.source ?? null, keyIsLive);
    const options = companyPaymentOptions(l);
    return {
      locationId: l.id,
      name: l.name,
      shortCode: l.short_code,
      account: view,
      options,
      // Same rule the pay link / pay intent use (lib/invoices/pay-link.ts): keys ready, an
      // account that serves this company in this mode, charges confirmed, a method on.
      acceptsOnline: mode.stripe.state === 'ready' && !!pick?.connection && pick.ready && (options.cardEnabled || options.achEnabled),
    };
  });

  const tenantConn = env ? connections.find((c) => collection(c) && c.locationId === null) ?? null : null;

  let fees: FeeLine[] | null = null;
  try {
    fees = feeLines(await resolveMerchantFeeSchedule(adminDb, orgId));
  } catch {
    fees = null; // display only — never block the screen on it
  }

  return {
    stripe: {
      state: mode.stripe.state,
      mode: mode.stripe.mode,
      isLive: keyIsLive,
      problem: mode.stripe.problem,
      webhookConfigured: mode.stripe.webhookConfigured,
      connectWebhookConfigured: mode.stripe.connectWebhookConfigured,
    },
    plaid: { label: mode.plaid.label, isLive: mode.plaid.isLive, configured: mode.plaid.configured, warning: mode.plaid.warning },
    accountMode,
    tenantAccount: tenantConn ? accountView(tenantConn, 'tenant', keyIsLive) : null,
    fees,
    companies,
    refreshedErrors,
  };
}
