/**
 * Can THIS invoice be paid online, and how? THE one answer (live check Wave 1, fix 1G-1)
 * for every surface that shows or takes an online payment:
 *   the PDF (pay URL + QR), the email Pay button, the drawer's Pay link panel, the invoice
 *   list "Online" column, the design screen's preview, the hosted pay page AND the
 *   pay-intent route (which refuses anything this says no to).
 *
 * Before 1G the documents used their own connection pick (any org-wide Stripe row, either
 * environment, status never checked), so a company Settings → Payments showed as "Stripe
 * not connected / Online payment off / Card off" still printed a live Pay link offering
 * card. Now the decision is built from the same pieces Settings → Payments uses:
 *
 *   - the server's Stripe keys can take a payment (payments-mode.ts: present + consistent);
 *   - the invoice's company has its OWN active Stripe connection in the CURRENT mode, or the
 *     tenant explicitly chose one shared account (org_payment_settings.account_mode
 *     'single') and the shared account is connected (payment-accounts.ts);
 *   - Stripe has confirmed that account can take charges (charges_enabled = true);
 *   - at least one ONLINE method (bank transfer / card) is on in the invoice → job →
 *     customer → company cascade (payment-terms.ts) AND the account supports it;
 *   - the invoice is ISSUED (not a DRAFT — a draft has no A/R posted and may still change)
 *     and open with a balance.
 * Otherwise the document prints the template's payment instructions only.
 *
 * The card fee % shown to the payer comes from the merchant fee schedule (fees.ts) and
 * whether it is passed through from the same cascade the intent charges by.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { PROVIDER_ONLINE_METHODS, type PaymentMethod } from '@/lib/invoices/resolve-payment-methods';
import { listConnections } from '@/lib/money/connections';
import { getAccountMode, pickCollectionConnection, type AccountMode, type CollectionSource } from '@/lib/money/payment-accounts';
import { loadInvoicePaymentTerms, resolvePaymentTerms, type PaymentTerms, type TermsLevel } from '@/lib/money/payment-terms';
import { stripeCanCharge, stripeConnectionEnv } from '@/lib/money/payments-mode';
import { DEFAULT_FEE_SCHEDULE, resolveMerchantFeeSchedule, type MerchantFeeSchedule } from '@/lib/money/fees';
import type { ProviderConnection, ProviderEnvironment } from '@/lib/money/providers/types';

export type PayMode = 'live' | 'test';

export type PayLinkCode =
  | 'OK'
  /** The server's Stripe keys are missing or don't match — nobody can pay online. */
  | 'PAYMENTS_OFF'
  /** No Stripe account serves this company in the current mode. */
  | 'NO_CONNECTION'
  /** The account exists but Stripe hasn't confirmed it can take charges. */
  | 'NOT_READY'
  | 'NO_ONLINE_METHOD'
  | 'PAID'
  | 'CLOSED'
  /** A DRAFT hasn't been issued (no GL posting, can still change) — never payable. */
  | 'NOT_ISSUED';

export interface PayLinkState {
  /** The hosted invoice page — always valid to OPEN (view + PDF), payable or not. */
  url: string;
  /** True only when the customer can actually pay online right now. */
  payable: boolean;
  mode: PayMode | null;
  /** Online methods the hosted page will offer (empty unless payable). */
  methods: PaymentMethod[];
  /** Plain-English reason when not payable (for staff), null when payable. */
  reason: string | null;
  /** Machine code for the reason. */
  code: PayLinkCode;
  /** True = the card processing fee is added to what the customer pays. */
  cardPassThrough: boolean;
  /** The card fee as a percent (merchant fee schedule), for the payer's disclosure. */
  cardFeePct: number;
}

/** The base URL customer links are built on (never a relative URL in a document). */
export function appBaseUrl(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL?.trim();
  return (raw && /^https?:\/\//.test(raw) ? raw : 'https://meritbooks-web.vercel.app').replace(/\/$/, '');
}

export function payUrlFor(publicToken: string): string {
  return `${appBaseUrl()}/pay/${publicToken}`;
}

/** A basis-point fee as a display percent (300 → 3, 290 → 2.9). */
export function bpsToPct(bps: number): number {
  return Math.round(bps) / 100;
}

/**
 * The online methods a connected account can take. Stripe accounts are created with card
 * + US bank account requested; if a snapshot of the account's capabilities was stored in
 * the connection metadata, a capability Stripe reports as inactive is dropped.
 */
export function accountSupportedMethods(conn: Pick<ProviderConnection, 'provider' | 'metadata'>): PaymentMethod[] {
  const base = conn.provider === 'stripe' ? PROVIDER_ONLINE_METHODS.STRIPE : PROVIDER_ONLINE_METHODS.DWOLLA;
  const caps = conn.metadata && typeof conn.metadata === 'object' ? (conn.metadata as Record<string, unknown>).capabilities : undefined;
  if (!caps || typeof caps !== 'object') return [...base];
  const c = caps as Record<string, unknown>;
  const off = (key: string) => typeof c[key] === 'string' && c[key] !== 'active';
  return base.filter((m) => !(m === 'CARD' ? off('card_payments') : off('us_bank_account_ach_payments')));
}

export interface PayLinkInput {
  publicToken: string;
  status: string;
  balanceCents: number;
  locationId: string | null;
  /** The resolved invoice → job → customer → company payment terms. */
  terms: Pick<PaymentTerms, 'online' | 'cardPassThrough'>;
  connections: ReadonlyArray<ProviderConnection>;
  accountMode: AccountMode;
  /** The server's Stripe state: can it charge, and which environment do its keys belong to. */
  stripe: { canCharge: boolean; environment: ProviderEnvironment | null };
  /** Merchant card fee in basis points (default schedule when unknown). */
  cardFeeBps?: number;
}

export interface PayDecision {
  state: PayLinkState;
  /** The account the payment settles to — server-side only, never sent to a browser. */
  connection: ProviderConnection | null;
  source: CollectionSource | null;
}

const NOT_SET_UP =
  'This company isn\'t set up to take online payments yet. The invoice prints your payment instructions instead. Connect Stripe for this company in Settings → Payments.';

/** Pure decision (unit-tested) — the account too, for the pay intent. */
export function evaluatePayLink(i: PayLinkInput): PayDecision {
  const url = payUrlFor(i.publicToken);
  const cardFeePct = bpsToPct(i.cardFeeBps ?? DEFAULT_FEE_SCHEDULE.cardFeeBps);
  const base = { url, payable: false, mode: null, methods: [] as PaymentMethod[], cardPassThrough: i.terms.cardPassThrough, cardFeePct };
  const no = (code: PayLinkCode, reason: string, extra: Partial<PayLinkState> = {}, connection: ProviderConnection | null = null, source: CollectionSource | null = null): PayDecision => ({
    state: { ...base, ...extra, code, reason },
    connection,
    source,
  });

  if (i.status === 'VOIDED' || i.status === 'WRITTEN_OFF') {
    return no('CLOSED', `This invoice is ${i.status === 'VOIDED' ? 'voided' : 'written off'}, so it can't be paid online.`);
  }
  if (i.status === 'DRAFT') {
    return no('NOT_ISSUED', 'This invoice is still a draft. Post (send) it before it can be paid online.');
  }
  if (i.balanceCents <= 0 || i.status === 'PAID') {
    return no('PAID', 'Paid in full. The link still opens the invoice.');
  }
  if (!i.stripe.canCharge || !i.stripe.environment) {
    return no('PAYMENTS_OFF', 'Online payment is off: Stripe isn\'t set up on the server (Settings → Payments shows what\'s missing). The invoice prints your payment instructions instead.');
  }
  const pick = pickCollectionConnection(i.connections, { locationId: i.locationId, mode: i.accountMode, environment: i.stripe.environment });
  if (!pick.connection) return no('NO_CONNECTION', NOT_SET_UP);
  const mode: PayMode = pick.connection.environment === 'live' ? 'live' : 'test';
  if (!pick.ready) {
    return no(
      'NOT_READY',
      pick.connection.account.chargesEnabled === false
        ? 'Stripe has paused payments for this company. Open Settings → Payments to see what Stripe needs.'
        : 'Stripe hasn\'t confirmed this company\'s account can take payments yet. Finish Stripe setup (or refresh its status) in Settings → Payments.',
      { mode },
      pick.connection,
      pick.source,
    );
  }
  const supported = accountSupportedMethods(pick.connection);
  const methods = i.terms.online.filter((m) => supported.includes(m));
  if (methods.length === 0) {
    return no(
      'NO_ONLINE_METHOD',
      'Online payment (bank transfer and card) is turned off for this invoice, its job, customer or company. The invoice prints your payment instructions instead.',
      { mode },
      pick.connection,
      pick.source,
    );
  }
  return {
    state: { ...base, payable: true, mode, methods, reason: null, code: 'OK' },
    connection: pick.connection,
    source: pick.source,
  };
}

/** The customer-facing state only. */
export function decidePayLink(i: PayLinkInput): PayLinkState {
  return evaluatePayLink(i).state;
}

/** Fail-closed state when the decision itself could not be made. */
export function unresolvedPayLink(publicToken: string): PayLinkState {
  return {
    url: publicToken ? payUrlFor(publicToken) : '',
    payable: false, mode: null, methods: [], code: 'NO_CONNECTION',
    reason: 'Online payment status could not be checked.',
    cardPassThrough: true, cardFeePct: bpsToPct(DEFAULT_FEE_SCHEDULE.cardFeeBps),
  };
}

export interface PayLinkInvoice {
  public_token: string;
  status: string;
  balance_cents: number;
  location_id: string | null;
  customer_id: string | null;
  job_id: string | null;
  payment_methods_allowed: string[] | null;
  card_surcharge_enabled?: boolean | null;
  ach_surcharge_enabled?: boolean | null;
}

/** The server-side Stripe state (keys), read once per request. */
function serverStripe(): PayLinkInput['stripe'] {
  return { canCharge: stripeCanCharge(), environment: stripeConnectionEnv() };
}

async function feeScheduleOrDefault(db: SupabaseClient, orgId: string): Promise<MerchantFeeSchedule> {
  try {
    return await resolveMerchantFeeSchedule(db, orgId);
  } catch (e) {
    console.error('[pay-link] fee schedule unavailable; showing the default rate', e);
    return DEFAULT_FEE_SCHEDULE;
  }
}

/**
 * DB-backed resolution (decision + account + terms + fee schedule). `db` must read
 * core.provider_connections, core.org_payment_settings and the cascade columns — the
 * service role (pay page, intent, send) or the member client (drawer; members can read
 * their own org's rows).
 */
export async function resolvePayDecision(
  db: SupabaseClient,
  orgId: string,
  inv: PayLinkInvoice,
): Promise<PayDecision & { terms: PaymentTerms; schedule: MerchantFeeSchedule }> {
  const [connections, accountMode, terms, schedule] = await Promise.all([
    listConnections(db, orgId),
    getAccountMode(db, orgId),
    loadInvoicePaymentTerms(db, {
      org_id: orgId,
      location_id: inv.location_id,
      customer_id: inv.customer_id,
      job_id: inv.job_id,
      payment_methods_allowed: inv.payment_methods_allowed,
      card_surcharge_enabled: inv.card_surcharge_enabled ?? null,
      ach_surcharge_enabled: inv.ach_surcharge_enabled ?? null,
    }),
    feeScheduleOrDefault(db, orgId),
  ]);
  const d = evaluatePayLink({
    publicToken: inv.public_token,
    status: inv.status,
    balanceCents: inv.balance_cents,
    locationId: inv.location_id,
    terms,
    connections,
    accountMode,
    stripe: serverStripe(),
    cardFeeBps: schedule.cardFeeBps,
  });
  return { ...d, terms, schedule };
}

/** The customer-facing state for one invoice. */
export async function resolvePayLink(db: SupabaseClient, orgId: string, inv: PayLinkInvoice): Promise<PayLinkState> {
  return (await resolvePayDecision(db, orgId, inv)).state;
}

/**
 * The same answer for a page of invoices (the list's "Online" column) in a fixed number
 * of queries: connections + account mode once, each cascade level batched by id.
 */
export async function resolvePayLinksBatch(
  db: SupabaseClient,
  orgId: string,
  invs: ReadonlyArray<PayLinkInvoice & { id: string }>,
): Promise<Map<string, PayLinkState>> {
  const out = new Map<string, PayLinkState>();
  if (invs.length === 0) return out;
  const ids = (k: 'location_id' | 'customer_id' | 'job_id') => [...new Set(invs.map((i) => i[k]).filter((x): x is string => !!x))];
  const COLS = 'id, payment_methods_allowed, card_surcharge_enabled, ach_surcharge_enabled';
  const levels = async (table: 'locations' | 'customers' | 'jobs', list: string[]): Promise<Map<string, TermsLevel>> => {
    if (list.length === 0) return new Map();
    const { data } = await db.schema('core').from(table).select(COLS).eq('org_id', orgId).in('id', list);
    return new Map(((data ?? []) as Array<TermsLevel & { id: string }>).map((r) => [r.id, r]));
  };
  const [connections, accountMode, locs, custs, jobs] = await Promise.all([
    listConnections(db, orgId),
    getAccountMode(db, orgId),
    levels('locations', ids('location_id')),
    levels('customers', ids('customer_id')),
    levels('jobs', ids('job_id')),
  ]);
  const stripe = serverStripe();
  for (const inv of invs) {
    const terms = resolvePaymentTerms({
      invoice: {
        payment_methods_allowed: inv.payment_methods_allowed,
        card_surcharge_enabled: inv.card_surcharge_enabled ?? null,
        ach_surcharge_enabled: inv.ach_surcharge_enabled ?? null,
      },
      job: inv.job_id ? jobs.get(inv.job_id) ?? null : null,
      customer: inv.customer_id ? custs.get(inv.customer_id) ?? null : null,
      entity: inv.location_id ? locs.get(inv.location_id) ?? null : null,
    });
    out.set(inv.id, decidePayLink({
      publicToken: inv.public_token, status: inv.status, balanceCents: inv.balance_cents, locationId: inv.location_id,
      terms, connections, accountMode, stripe,
    }));
  }
  return out;
}

/**
 * Company-level answer (design screen: "would a printed invoice for this company carry a
 * pay link?") — the company's own settings only, no invoice/customer/job overrides.
 */
export async function resolveCompanyPayLink(db: SupabaseClient, orgId: string, locationId: string | null, publicToken: string): Promise<PayLinkState> {
  return resolvePayLink(db, orgId, {
    public_token: publicToken, status: 'SENT', balance_cents: 1, location_id: locationId,
    customer_id: null, job_id: null, payment_methods_allowed: null,
  });
}
