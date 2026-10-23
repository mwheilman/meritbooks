/**
 * Can THIS invoice be paid online, and where? One answer for the PDF (pay URL + QR),
 * the email (Pay button), the drawer's Pay link panel and the hosted pay page.
 *
 * The rule a printed invoice must keep: never print a dead link. A pay URL / QR /
 * Pay button appears only when ALL of these hold:
 *   - the company has an ACTIVE online-payment connection (Stripe, AR_COLLECTION) with a
 *     connected account — test or live; the mode is reported so staff see TEST honestly;
 *   - at least one ONLINE method (ACH / card) is allowed by the invoice → job → customer →
 *     company cascade;
 *   - the invoice is open (not voided / written off) and has a balance.
 * Otherwise the document prints the template's payment instructions only.
 *
 * Connection scope: if core.provider_connections carries a location_id (Wave 1A,
 * migration 175 — one Stripe account per company), a row for the invoice's company wins,
 * then an org-wide row (location_id null); a row for ANOTHER company never applies. Before
 * 175 every row is org-wide, exactly as the pay-intent route reads it today.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  onlineMethods,
  resolvePaymentMethods,
  type MethodCascadeLevels,
  type PaymentMethod,
} from '@/lib/invoices/resolve-payment-methods';

export type PayMode = 'live' | 'test';

export interface PayLinkState {
  /** The hosted invoice page — always valid to OPEN (view + PDF), payable or not. */
  url: string;
  /** True only when the customer can actually pay online right now. */
  payable: boolean;
  mode: PayMode | null;
  /** Online methods the hosted page will offer. */
  methods: PaymentMethod[];
  /** Plain-English reason when not payable (for staff), null when payable. */
  reason: string | null;
  /** Machine code for the reason. */
  code: 'OK' | 'NO_CONNECTION' | 'NO_ONLINE_METHOD' | 'PAID' | 'CLOSED';
}

export interface ConnectionLite {
  capability: string;
  provider: string;
  status: string;
  environment: string;
  account_handle: string | null;
  /** Present once Wave 1A's migration 175 lands; undefined before. */
  location_id?: string | null;
}

/** The base URL customer links are built on (never a relative URL in a document). */
export function appBaseUrl(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL?.trim();
  return (raw && /^https?:\/\//.test(raw) ? raw : 'https://meritbooks-web.vercel.app').replace(/\/$/, '');
}

export function payUrlFor(publicToken: string): string {
  return `${appBaseUrl()}/pay/${publicToken}`;
}

/** Pick the connection that serves a company (own row → org-wide row → none). */
export function pickArConnection(conns: ReadonlyArray<ConnectionLite>, locationId: string | null): ConnectionLite | null {
  const usable = conns.filter(
    (c) => c.capability === 'AR_COLLECTION' && c.provider === 'stripe' && c.status === 'active' && !!c.account_handle,
  );
  if (locationId) {
    const own = usable.find((c) => c.location_id === locationId);
    if (own) return own;
  }
  return usable.find((c) => c.location_id === undefined || c.location_id === null) ?? null;
}

export interface PayLinkInput {
  publicToken: string;
  status: string;
  balanceCents: number;
  locationId: string | null;
  methodLevels: MethodCascadeLevels;
  connections: ReadonlyArray<ConnectionLite>;
}

/** Pure decision (unit-tested). */
export function decidePayLink(i: PayLinkInput): PayLinkState {
  const url = payUrlFor(i.publicToken);
  const base = { url, payable: false, mode: null, methods: [] as PaymentMethod[] };
  if (i.status === 'VOIDED' || i.status === 'WRITTEN_OFF') {
    return { ...base, code: 'CLOSED', reason: `This invoice is ${i.status === 'VOIDED' ? 'voided' : 'written off'}, so it can't be paid online.` };
  }
  if (i.balanceCents <= 0 || i.status === 'PAID') {
    return { ...base, code: 'PAID', reason: 'Paid in full. The link still opens the invoice.' };
  }
  const conn = pickArConnection(i.connections, i.locationId);
  if (!conn) {
    return {
      ...base,
      code: 'NO_CONNECTION',
      reason: 'This company isn\'t set up to take online payments yet. The invoice prints your payment instructions instead. Connect Stripe in Settings → Payments.',
    };
  }
  const methods = onlineMethods(resolvePaymentMethods(i.methodLevels, 'STRIPE'));
  const mode: PayMode = conn.environment === 'live' ? 'live' : 'test';
  if (methods.length === 0) {
    return {
      ...base,
      mode,
      code: 'NO_ONLINE_METHOD',
      reason: 'Online payment (bank transfer or card) is turned off for this invoice, its job, customer or company. The invoice prints your payment instructions instead.',
    };
  }
  return { url, payable: true, mode, methods, reason: null, code: 'OK' };
}

/**
 * DB-backed resolution. `db` must be able to read core.provider_connections and the
 * cascade columns — pass the service role (pay page, send) or the member client
 * (drawer; RLS lets members read their own org's connections).
 */
export async function resolvePayLink(
  db: SupabaseClient,
  orgId: string,
  inv: {
    public_token: string;
    status: string;
    balance_cents: number;
    location_id: string | null;
    customer_id: string | null;
    job_id: string | null;
    payment_methods_allowed: string[] | null;
  },
): Promise<PayLinkState> {
  const loadConns = async (): Promise<{ data: unknown[] | null }> => {
    // `*` picks up Wave 1A's location_id when it exists; if a column grant ever refuses
    // `*` for the caller, fall back to the columns this decision needs.
    const all = await db.schema('core').from('provider_connections').select('*').eq('org_id', orgId).eq('capability', 'AR_COLLECTION');
    if (!all.error) return { data: all.data };
    const some = await db.schema('core').from('provider_connections')
      .select('capability, provider, status, environment, account_handle').eq('org_id', orgId).eq('capability', 'AR_COLLECTION');
    return { data: some.error ? [] : some.data };
  };
  const [conns, cust, job, loc] = await Promise.all([
    loadConns(),
    inv.customer_id
      ? db.schema('core').from('customers').select('payment_methods_allowed').eq('org_id', orgId).eq('id', inv.customer_id).maybeSingle()
      : Promise.resolve({ data: null }),
    inv.job_id
      ? db.schema('core').from('jobs').select('payment_methods_allowed').eq('org_id', orgId).eq('id', inv.job_id).maybeSingle()
      : Promise.resolve({ data: null }),
    inv.location_id
      ? db.schema('core').from('locations').select('payment_methods_allowed').eq('org_id', orgId).eq('id', inv.location_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const levels = (r: { data: unknown }) => ((r.data as { payment_methods_allowed?: string[] | null } | null)?.payment_methods_allowed ?? null);
  return decidePayLink({
    publicToken: inv.public_token,
    status: inv.status,
    balanceCents: inv.balance_cents,
    locationId: inv.location_id,
    methodLevels: { invoice: inv.payment_methods_allowed, job: levels(job), customer: levels(cust), entity: levels(loc) },
    connections: ((conns.data ?? []) as Record<string, unknown>[]).map((c) => ({
      capability: String(c.capability ?? ''),
      provider: String(c.provider ?? ''),
      status: String(c.status ?? ''),
      environment: String(c.environment ?? 'test'),
      account_handle: (c.account_handle as string | null) ?? null,
      ...('location_id' in c ? { location_id: (c.location_id as string | null) ?? null } : {}),
    })),
  });
}
