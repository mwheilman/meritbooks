/**
 * GATE 12.0 — Plaid bank-feed adapter (Books).
 *
 * Implements the `BankFeed` capability interface. Plaid is unusual among our
 * providers: the client_id + secret are PLATFORM credentials (the same for every
 * tenant — they identify our app to Plaid), while each tenant's bank login
 * produces a per-Item `access_token` that is the per-tenant secret.
 *
 * Storage, accordingly:
 *   - Platform client_id  -> env PLAID_CLIENT_ID (public-ish)
 *   - Platform secret     -> Supabase Vault, ref in env PLAID_SECRET_REF
 *                            (falls back to env PLAID_SECRET for first-run/local)
 *   - Per-Item access_token -> Vault, ref on core.provider_connections.secret_ref
 *                              (capability 'BANK_FEED'), one connection per Item
 *
 * The Plaid SDK type surface never leaks above this file — callers get plain
 * domain shapes, exactly like the other adapters. Server/service-role only.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  Products,
  CountryCode,
  type Transaction as PlaidTransaction,
  type AccountBase,
} from 'plaid';
import { readProviderSecret } from '@/lib/money/secrets';
import type { BankFeed } from '@/lib/money/providers/types';

export type PlaidEnv = 'sandbox' | 'production';

/** Resolve the platform Plaid secret: Vault (preferred) or raw env fallback. */
async function resolvePlatformSecret(adminDb: SupabaseClient): Promise<string> {
  const ref = process.env.PLAID_SECRET_REF;
  if (ref) {
    const fromVault = await readProviderSecret(adminDb, ref);
    if (fromVault) return fromVault;
  }
  const raw = process.env.PLAID_SECRET;
  if (raw) return raw;
  throw new Error('Plaid platform secret not configured (set PLAID_SECRET_REF to a Vault ref, or PLAID_SECRET).');
}

function plaidBasePath(env: PlaidEnv): string {
  return env === 'production' ? PlaidEnvironments.production : PlaidEnvironments.sandbox;
}

/** Build a configured PlaidApi client for the platform. */
export async function makePlaidClient(adminDb: SupabaseClient, env: PlaidEnv): Promise<PlaidApi> {
  const clientId = process.env.PLAID_CLIENT_ID;
  if (!clientId) throw new Error('PLAID_CLIENT_ID is not set.');
  const secret = await resolvePlatformSecret(adminDb);

  const config = new Configuration({
    basePath: plaidBasePath(env),
    baseOptions: {
      headers: { 'PLAID-CLIENT-ID': clientId, 'PLAID-SECRET': secret },
    },
  });
  return new PlaidApi(config);
}

/** Map a Plaid SDK error into a readable message + a re-auth flag. */
export function describePlaidError(e: unknown): { message: string; loginRequired: boolean } {
  const resp = (e as { response?: { data?: { error_code?: string; error_message?: string } } })?.response?.data;
  const code = resp?.error_code ?? '';
  const message = resp?.error_message ?? (e instanceof Error ? e.message : 'Plaid request failed');
  const loginRequired = code === 'ITEM_LOGIN_REQUIRED' || code === 'PENDING_EXPIRATION';
  return { message, loginRequired };
}

// ---------------------------------------------------------------------------
// Link / token lifecycle (platform-level operations)
// ---------------------------------------------------------------------------

/** Create a Link token to open Plaid Link in the browser. */
export async function createLinkToken(
  adminDb: SupabaseClient,
  env: PlaidEnv,
  input: { clientUserId: string; clientName: string },
): Promise<string> {
  const client = await makePlaidClient(adminDb, env);
  const res = await client.linkTokenCreate({
    user: { client_user_id: input.clientUserId },
    client_name: input.clientName,
    products: [Products.Transactions],
    country_codes: [CountryCode.Us],
    language: 'en',
  });
  return res.data.link_token;
}

/** Exchange the public token (from Link) for a durable access token + Item id. */
export async function exchangePublicToken(
  adminDb: SupabaseClient,
  env: PlaidEnv,
  publicToken: string,
): Promise<{ accessToken: string; itemId: string }> {
  const client = await makePlaidClient(adminDb, env);
  const res = await client.itemPublicTokenExchange({ public_token: publicToken });
  return { accessToken: res.data.access_token, itemId: res.data.item_id };
}

export interface PlaidAccountInfo {
  plaidAccountId: string;
  name: string;
  mask: string | null;
  type: string;            // CHECKING | SAVINGS | CREDIT_CARD | LINE_OF_CREDIT (normalized)
  currentBalanceCents: number | null;
  availableBalanceCents: number | null;
}

export interface PlaidInstitutionInfo {
  institutionId: string | null;
  institutionName: string | null;
}

function toCents(n: number | null | undefined): number | null {
  if (n === null || n === undefined) return null;
  return Math.round(n * 100);
}

/** Normalize a Plaid account subtype to our bank_accounts.account_type enum. */
function normalizeAccountType(acct: AccountBase): string {
  const sub = (acct.subtype ?? '').toString().toLowerCase();
  const type = (acct.type ?? '').toString().toLowerCase();
  if (sub === 'checking') return 'CHECKING';
  if (sub === 'savings') return 'SAVINGS';
  if (type === 'credit' || sub === 'credit card') return 'CREDIT_CARD';
  if (sub === 'line of credit' || sub === 'business') return 'LINE_OF_CREDIT';
  // Sensible default for depository accounts.
  return type === 'depository' ? 'CHECKING' : 'CHECKING';
}

/** Fetch the accounts + institution for a connected Item (using its access token). */
export async function fetchItemAccounts(
  adminDb: SupabaseClient,
  env: PlaidEnv,
  accessToken: string,
): Promise<{ accounts: PlaidAccountInfo[]; institution: PlaidInstitutionInfo }> {
  const client = await makePlaidClient(adminDb, env);

  const acctRes = await client.accountsGet({ access_token: accessToken });
  const accounts: PlaidAccountInfo[] = acctRes.data.accounts.map((a) => ({
    plaidAccountId: a.account_id,
    name: a.official_name ?? a.name,
    mask: a.mask ?? null,
    type: normalizeAccountType(a),
    currentBalanceCents: toCents(a.balances.current),
    availableBalanceCents: toCents(a.balances.available),
  }));

  const itemRes = await client.itemGet({ access_token: accessToken });
  const instId = itemRes.data.item.institution_id ?? null;
  let instName: string | null = null;
  if (instId) {
    try {
      const inst = await client.institutionsGetById({
        institution_id: instId,
        country_codes: [CountryCode.Us],
      });
      instName = inst.data.institution.name;
    } catch {
      instName = null;
    }
  }

  return { accounts, institution: { institutionId: instId, institutionName: instName } };
}

export interface SyncedTransaction {
  plaidTransactionId: string;
  plaidAccountId: string;
  postedDate: string;   // ISO yyyy-mm-dd
  authorizedDate: string | null;
  description: string;
  // amount in cents, signed for our ledger convention: negative = money out (debit),
  // positive = money in (credit). (Plaid uses positive = money out, so we flip.)
  amountCents: number;
  category: string | null;
  pending: boolean;
}

export interface SyncResult {
  added: SyncedTransaction[];
  modified: SyncedTransaction[];
  removedIds: string[];
  nextCursor: string;
  hasMore: boolean;
}

function mapPlaidTxn(t: PlaidTransaction): SyncedTransaction {
  // Plaid: amount > 0 means money leaving the account. Our convention: negative = out.
  const amountCents = Math.round((t.amount ?? 0) * -100);
  const category =
    (t.personal_finance_category?.primary ?? null) ||
    (Array.isArray(t.category) && t.category.length ? t.category[0] : null);
  return {
    plaidTransactionId: t.transaction_id,
    plaidAccountId: t.account_id,
    postedDate: t.date,
    authorizedDate: t.authorized_date ?? null,
    description: t.merchant_name ?? t.name,
    amountCents,
    category,
    pending: !!t.pending,
  };
}

/**
 * Incremental transaction sync via /transactions/sync. Pass the stored cursor
 * (null for first sync). Paginates internally until Plaid reports no more pages,
 * returning the full delta + the cursor to persist.
 */
export async function syncItemTransactions(
  adminDb: SupabaseClient,
  env: PlaidEnv,
  accessToken: string,
  cursor: string | null,
): Promise<SyncResult> {
  const client = await makePlaidClient(adminDb, env);

  const added: SyncedTransaction[] = [];
  const modified: SyncedTransaction[] = [];
  const removedIds: string[] = [];
  let nextCursor = cursor ?? '';
  let hasMore = true;

  // Guard against an unbounded loop; Plaid pages are large.
  let pages = 0;
  while (hasMore && pages < 50) {
    pages += 1;
    const res = await client.transactionsSync({
      access_token: accessToken,
      cursor: nextCursor || undefined,
      count: 500,
    });
    const d = res.data;
    for (const t of d.added) added.push(mapPlaidTxn(t));
    for (const t of d.modified) modified.push(mapPlaidTxn(t));
    for (const r of d.removed) if (r.transaction_id) removedIds.push(r.transaction_id);
    nextCursor = d.next_cursor;
    hasMore = d.has_more;
  }

  return { added, modified, removedIds, nextCursor, hasMore: false };
}

/** Current + available balance in cents, per Plaid account, for a refresh. */
export async function fetchBalances(
  adminDb: SupabaseClient,
  env: PlaidEnv,
  accessToken: string,
): Promise<Record<string, { currentCents: number | null; availableCents: number | null }>> {
  const client = await makePlaidClient(adminDb, env);
  const res = await client.accountsBalanceGet({ access_token: accessToken });
  const out: Record<string, { currentCents: number | null; availableCents: number | null }> = {};
  for (const a of res.data.accounts) {
    out[a.account_id] = {
      currentCents: toCents(a.balances.current),
      availableCents: toCents(a.balances.available),
    };
  }
  return out;
}

/**
 * The BankFeed-interface conformant view, for adapter-boundary callers that want
 * the generic shape. (The richer functions above are what the sync route uses.)
 */
export function makePlaidBankFeed(adminDb: SupabaseClient, env: PlaidEnv, accessToken: string): BankFeed {
  return {
    provider: 'plaid',
    async syncTransactions({ sinceCursor }) {
      const r = await syncItemTransactions(adminDb, env, accessToken, sinceCursor ?? null);
      return {
        added: r.added.map((t) => ({
          providerTxnId: t.plaidTransactionId,
          postedAt: t.postedDate,
          amountCents: t.amountCents,
          description: t.description,
        })),
        nextCursor: r.nextCursor,
      };
    },
    async getBalanceCents() {
      const balances = await fetchBalances(adminDb, env, accessToken);
      const first = Object.values(balances)[0];
      return first?.currentCents ?? 0;
    },
  };
}
