/**
 * Per-company Stripe accounts (FPB-payments-fees §17.2, migration 175, audit PM-02).
 *
 * Each company (core.locations row) collects into ITS OWN Stripe connected account, so a
 * customer's payment settles to the bank account of the company that issued the invoice.
 * A tenant can explicitly opt into "one account for all companies" (account_mode
 * 'single'); then a tenant-level connection (location_id null) is the fallback.
 *
 * Rules (all here, so the pay intent, the webhook and the settings screen agree):
 *   - only rows of the CURRENT Stripe environment (derived from the key) are ever used;
 *   - the invoice company's own account wins; the tenant-level account is used ONLY in
 *     'single' mode; otherwise online payment is off for that invoice;
 *   - a connected account id is NEVER taken from a browser — it is always resolved here
 *     from (org, company) or, for webhooks, from the signed event;
 *   - every payout-bank change is written to audit_log (old/new last 4 only).
 *
 * Server/service-role only (core.provider_connections + core.org_payment_settings are
 * SELECT-only for members; writes happen after the route's permission check).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { listConnections } from '@/lib/money/connections';
import type { ConnectedAccountSnapshot, ProviderConnection, ProviderEnvironment } from '@/lib/money/providers/types';
import { stripeConnectionEnv } from '@/lib/money/payments-mode';
import { getConnectedAccountDetails, type ConnectedAccountDetails } from '@/lib/money/providers/stripe';
import { serviceWriter } from '@/lib/db/scoped-writer';

export type AccountMode = 'per_company' | 'single';
export const DEFAULT_ACCOUNT_MODE: AccountMode = 'per_company';

// ── settings ──────────────────────────────────────────────────────────────────

/** The tenant's account mode; no row (or a read error) = the safe default, per company. */
export async function getAccountMode(db: SupabaseClient, orgId: string): Promise<AccountMode> {
  const { data, error } = await db
    .schema('core')
    .from('org_payment_settings')
    .select('account_mode')
    .eq('org_id', orgId)
    .maybeSingle<{ account_mode: string }>();
  if (error || !data) return DEFAULT_ACCOUNT_MODE;
  return data.account_mode === 'single' ? 'single' : 'per_company';
}

/** Set the account mode (service role, after settings_system:edit). Audited. */
export async function setAccountMode(adminDb: SupabaseClient, orgId: string, mode: AccountMode, userId: string): Promise<void> {
  const before = await getAccountMode(adminDb, orgId);
  const { data: existing } = await adminDb.schema('core').from('org_payment_settings').select('org_id').eq('org_id', orgId).maybeSingle();
  const values = { account_mode: mode, updated_by: userId, updated_at: new Date().toISOString() };
  const { error } = existing
    ? await serviceWriter(adminDb).schema('core').from('org_payment_settings').update(values).eq('org_id', orgId)
    : await serviceWriter(adminDb).schema('core').from('org_payment_settings').insert({ org_id: orgId, ...values });
  if (error) throw new Error(error.message);
  if (before !== mode) {
    await writeAudit(adminDb, { orgId, table: 'org_payment_settings', recordId: orgId, field: 'account_mode', oldValue: before, newValue: mode, userId });
  }
}

// ── resolution ────────────────────────────────────────────────────────────────

export type CollectionSource = 'company' | 'tenant';

export type CollectionPick =
  | { connection: ProviderConnection; source: CollectionSource; ready: boolean }
  | { connection: null; source: null; ready: false };

/** Has Stripe confirmed this account can take charges? */
export function chargesConfirmed(c: Pick<ProviderConnection, 'account'>): boolean {
  return c.account.chargesEnabled === true;
}

/** Is this an active Stripe collection account of the given environment? */
function isStripeCollection(c: ProviderConnection, environment: ProviderEnvironment): boolean {
  return c.capability === 'AR_COLLECTION' && c.provider === 'stripe' && c.status === 'active' && !!c.accountHandle && c.environment === environment;
}

/**
 * Pick the account an invoice of `locationId` collects into. Pure (unit-tested).
 *   company account (same environment)  → it
 *   else, account_mode 'single'         → the tenant-level account
 *   else                                → none (online payment off for this invoice)
 * `ready` = Stripe has CONFIRMED the account can take charges (charges_enabled = true). A
 * never-checked account (null) is not ready: a printed pay link must never be dead, so
 * Settings → Payments, the documents and the pay intent all wait for Stripe's word
 * (the Connect webhook or a status refresh fills it in). Live check Wave 1, fix 1G-1.
 */
export function pickCollectionConnection(
  connections: ReadonlyArray<ProviderConnection>,
  opts: { locationId: string | null; mode: AccountMode; environment: ProviderEnvironment },
): CollectionPick {
  const usable = connections.filter((c) => isStripeCollection(c, opts.environment));
  const own = opts.locationId ? usable.find((c) => c.locationId === opts.locationId) : undefined;
  const tenant = opts.mode === 'single' ? usable.find((c) => c.locationId === null) : undefined;
  const chosen = own ?? tenant;
  if (!chosen) return { connection: null, source: null, ready: false };
  return { connection: chosen, source: own ? 'company' : 'tenant', ready: chargesConfirmed(chosen) };
}

/** Resolve the collection account for an invoice's company in the CURRENT Stripe environment. */
export async function resolveCollectionAccount(adminDb: SupabaseClient, orgId: string, locationId: string | null): Promise<CollectionPick & { environment: ProviderEnvironment | null }> {
  const environment = stripeConnectionEnv();
  if (!environment) return { connection: null, source: null, ready: false, environment: null };
  const [connections, mode] = await Promise.all([listConnections(adminDb, orgId), getAccountMode(adminDb, orgId)]);
  return { ...pickCollectionConnection(connections, { locationId, mode, environment }), environment };
}

/** A connected account id from a signed webhook → the connection (org, company). */
export interface AccountOwner {
  connectionId: string;
  orgId: string;
  locationId: string | null;
  environment: ProviderEnvironment;
}

export async function findConnectionByAccount(adminDb: SupabaseClient, accountId: string): Promise<AccountOwner | null> {
  if (!accountId) return null;
  const { data, error } = await adminDb
    .schema('core')
    .from('provider_connections')
    .select('id, org_id, location_id, environment, updated_at')
    .eq('account_handle', accountId)
    .eq('capability', 'AR_COLLECTION')
    .eq('provider', 'stripe')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; org_id: string; location_id: string | null; environment: ProviderEnvironment }>();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return { connectionId: data.id, orgId: data.org_id, locationId: data.location_id ?? null, environment: data.environment };
}

/**
 * The company a payout from `owner` posts to. A per-company account → its company. A
 * tenant-level account (single mode) → the tenant's first company, as before 175 (the
 * payout then mixes companies — the reason per-company is the default).
 */
export async function payoutLocationFor(adminDb: SupabaseClient, owner: AccountOwner): Promise<string | null> {
  if (owner.locationId) return owner.locationId;
  const { data } = await adminDb
    .schema('core')
    .from('locations')
    .select('id')
    .eq('org_id', owner.orgId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle<{ id: string }>();
  return data?.id ?? null;
}

// ── account status ────────────────────────────────────────────────────────────

export type AccountReadiness = 'not_connected' | 'setup_incomplete' | 'restricted' | 'ready';

/** Plain readiness of a cached snapshot. Pure. */
export function accountReadiness(conn: Pick<ProviderConnection, 'accountHandle' | 'account'> | null): AccountReadiness {
  if (!conn?.accountHandle) return 'not_connected';
  const a = conn.account;
  if (a.chargesEnabled === true && a.payoutsEnabled !== false && !a.disabledReason) return 'ready';
  if (a.detailsSubmitted === true || a.disabledReason) return 'restricted';
  return 'setup_incomplete';
}

/** Plain-English readiness labels (no Stripe codes). */
export const READINESS_LABEL: Record<AccountReadiness, string> = {
  not_connected: 'Not connected',
  setup_incomplete: 'Setup not finished',
  restricted: 'Needs attention',
  ready: 'Ready',
};

/** Stripe's `requirements.disabled_reason` codes → a sentence an owner understands. */
export function disabledReasonText(code: string | null): string | null {
  if (!code) return null;
  if (code.startsWith('requirements.past_due')) return 'Stripe needs more information before this company can take payments.';
  if (code.startsWith('requirements.pending_verification')) return 'Stripe is verifying the details you sent. This usually takes a few minutes.';
  if (code.startsWith('rejected')) return 'Stripe declined this account. Contact Stripe support from the Stripe dashboard.';
  if (code === 'listed') return 'Stripe is reviewing this account.';
  if (code === 'under_review') return 'Stripe is reviewing this account.';
  if (code === 'platform_paused') return 'Payments for this account are paused.';
  return 'Stripe has paused payments on this account. Open Stripe to see what it needs.';
}

function snapshotChanged(prev: ConnectedAccountSnapshot, next: ConnectedAccountDetails): boolean {
  return (
    prev.chargesEnabled !== next.chargesEnabled ||
    prev.payoutsEnabled !== next.payoutsEnabled ||
    prev.detailsSubmitted !== next.detailsSubmitted ||
    prev.disabledReason !== next.disabledReason ||
    prev.payoutBankLast4 !== next.payoutBankLast4 ||
    prev.payoutBankName !== next.payoutBankName ||
    prev.requirementsDue.join(',') !== next.requirementsDue.join(',')
  );
}

function bankLabel(name: string | null, last4: string | null): string {
  if (!last4) return 'none';
  return `${name ?? 'Bank'} ··${last4}`;
}

/**
 * Store what Stripe told us about an account on its connection row; a payout-bank change
 * (added, replaced, removed) is written to audit_log. `actor` = Clerk user id, or
 * 'stripe' for a webhook.
 */
export async function applyAccountDetails(
  adminDb: SupabaseClient,
  conn: Pick<ProviderConnection, 'id' | 'orgId' | 'account'>,
  details: ConnectedAccountDetails,
  actor: string,
): Promise<{ changed: boolean; bankChanged: boolean }> {
  const prev = conn.account;
  const changed = snapshotChanged(prev, details);
  const { error } = await serviceWriter(adminDb)
    .schema('core')
    .from('provider_connections')
    .update({
      charges_enabled: details.chargesEnabled,
      payouts_enabled: details.payoutsEnabled,
      details_submitted: details.detailsSubmitted,
      disabled_reason: details.disabledReason,
      requirements_due: details.requirementsDue,
      payout_bank_name: details.payoutBankName,
      payout_bank_last4: details.payoutBankLast4,
      status_checked_at: new Date().toISOString(),
    })
    .eq('org_id', conn.orgId)
    .eq('id', conn.id);
  if (error) throw new Error(error.message);

  const bankChanged = prev.payoutBankLast4 !== details.payoutBankLast4 || (prev.payoutBankName !== details.payoutBankName && !!details.payoutBankLast4);
  // The first check of a brand-new account records the bank it starts with too.
  if (bankChanged && (prev.payoutBankLast4 !== null || details.payoutBankLast4 !== null)) {
    await writeAudit(adminDb, {
      orgId: conn.orgId,
      table: 'provider_connections',
      recordId: conn.id,
      field: 'payout_bank',
      oldValue: bankLabel(prev.payoutBankName, prev.payoutBankLast4),
      newValue: bankLabel(details.payoutBankName, details.payoutBankLast4),
      userId: actor,
    });
  }
  return { changed, bankChanged };
}

/** Ask Stripe for the account's current status and store it. */
export async function refreshAccountStatus(adminDb: SupabaseClient, conn: ProviderConnection, actor: string): Promise<ConnectedAccountDetails> {
  if (!conn.accountHandle) throw new Error('This company has no Stripe account yet.');
  const details = await getConnectedAccountDetails(conn.accountHandle);
  await applyAccountDetails(adminDb, conn, details, actor);
  return details;
}

// ── audit ─────────────────────────────────────────────────────────────────────

export async function writeAudit(
  adminDb: SupabaseClient,
  a: { orgId: string; table: string; recordId: string; field: string; oldValue: string | null; newValue: string | null; userId: string; action?: 'INSERT' | 'UPDATE' | 'DELETE' },
): Promise<void> {
  const { error } = await serviceWriter(adminDb).from('audit_log').insert({
    org_id: a.orgId,
    table_name: a.table,
    record_id: a.recordId,
    action: a.action ?? 'UPDATE',
    field_name: a.field,
    old_value: a.oldValue,
    new_value: a.newValue,
    user_id: a.userId,
  });
  // Audit is evidence: surface a failure in logs, but never undo the change it records.
  if (error) console.error('[payments] audit_log write failed', a.table, a.field, error.message);
}
