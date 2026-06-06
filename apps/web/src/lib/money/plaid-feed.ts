/**
 * GATE 12.0 — Plaid feed service (Books).
 *
 * The DB-facing half of the Plaid bank feed: it owns the persistence side that
 * the adapter (lib/money/providers/plaid.ts) deliberately stays out of. It
 *   - registers the Item connection in core.provider_connections (Vault token),
 *   - records the plaid_items row (cursor + health),
 *   - upserts bank_accounts from the Item's accounts,
 *   - runs an incremental sync and persists bank_transactions (dedupe by Plaid id),
 *   - refreshes balances,
 *   - surfaces re-auth state.
 *
 * Server/service-role (admin client) only — it writes across schemas and Vault.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { connectProvider } from '@/lib/money/connections';
import { resolveProviderContext } from '@/lib/money/connections';
import {
  type PlaidEnv,
  exchangePublicToken,
  fetchItemAccounts,
  syncItemTransactions,
  fetchBalances,
  describePlaidError,
} from '@/lib/money/providers/plaid';

const ENV: PlaidEnv = (process.env.PLAID_ENV === 'production' ? 'production' : 'sandbox');
const CONN_ENV = ENV === 'production' ? 'live' : 'test';

interface BankAccountRow {
  id: string;
  org_id: string;
  location_id: string;
  account_id: string;
  plaid_account_id: string | null;
  plaid_item_pk: string | null;
}

/** A location is required on bank_accounts; use the tenant's first/primary location. */
async function resolvePrimaryLocationId(adminDb: SupabaseClient, orgId: string): Promise<string> {
  const { data, error } = await adminDb
    .schema('core')
    .from('locations')
    .select('id')
    .eq('org_id', orgId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle<{ id: string }>();
  if (error) throw new Error(`Could not resolve a location: ${error.message}`);
  if (!data?.id) throw new Error('No location found for tenant; create a location before connecting a bank.');
  return data.id;
}

/** The GL cash account to attach to a new bank account (operating_bank role, else first ASSET cash). */
async function resolveCashGlAccount(adminDb: SupabaseClient, orgId: string): Promise<string> {
  // Prefer an account tagged with the operating_bank / cash role.
  const { data: roleRow } = await adminDb
    .from('account_roles')
    .select('account_id, role_key')
    .eq('org_id', orgId)
    .in('role_key', ['operating_bank', 'cash'])
    .limit(1)
    .maybeSingle<{ account_id: string }>();
  if (roleRow?.account_id) return roleRow.account_id;

  // Fallback: first asset account that looks like cash/bank by number (1xxx).
  const { data: acct, error } = await adminDb
    .from('accounts')
    .select('id, account_number, account_type')
    .eq('org_id', orgId)
    .eq('account_type', 'ASSET')
    .order('account_number', { ascending: true })
    .limit(1)
    .maybeSingle<{ id: string }>();
  if (error) throw new Error(`Could not resolve a cash GL account: ${error.message}`);
  if (!acct?.id) throw new Error('No asset account found to map the bank account to.');
  return acct.id;
}

export interface ConnectResult {
  connectionId: string;
  itemPk: string;
  plaidItemId: string;
  institutionName: string | null;
  accountsLinked: number;
}

/**
 * Complete a Link flow: exchange the public token, register the connection,
 * record the Item, upsert its accounts. Returns a summary for the UI.
 */
export async function completePlaidLink(
  adminDb: SupabaseClient,
  orgId: string,
  input: { publicToken: string; connectedBy: string },
): Promise<ConnectResult> {
  const { accessToken, itemId } = await exchangePublicToken(adminDb, ENV, input.publicToken);
  const { accounts, institution } = await fetchItemAccounts(adminDb, ENV, accessToken);

  // 1) Register the connection (stores the access_token in Vault, returns the row).
  //    provider 'plaid' + a per-Item account_handle so multiple Items coexist.
  const connection = await connectProvider(adminDb, orgId, {
    capability: 'BANK_FEED',
    provider: 'plaid',
    environment: CONN_ENV,
    accountHandle: itemId,
    secret: accessToken,
    connectedBy: input.connectedBy,
    metadata: { institution_id: institution.institutionId, institution_name: institution.institutionName },
  });

  // 2) Record the Plaid Item (cursor starts null = full first sync).
  const { data: itemRow, error: itemErr } = await adminDb
    .from('plaid_items')
    .upsert(
      {
        org_id: orgId,
        connection_id: connection.id,
        plaid_item_id: itemId,
        institution_id: institution.institutionId,
        institution_name: institution.institutionName,
        status: 'active',
      },
      { onConflict: 'org_id,plaid_item_id' },
    )
    .select('id')
    .single<{ id: string }>();
  if (itemErr) throw new Error(`Failed to record Plaid item: ${itemErr.message}`);

  // 3) Upsert bank_accounts for each Plaid account. Errors are collected and
  //    surfaced (NOT swallowed) so a constraint failure can't masquerade as a
  //    successful link. Only depository accounts (checking/savings) become bank
  //    accounts; loans/investments/credit are skipped for the cash feed.
  const locationId = await resolvePrimaryLocationId(adminDb, orgId);
  const glAccountId = await resolveCashGlAccount(adminDb, orgId);

  let linked = 0;
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const a of accounts) {
    if (a.type !== 'CHECKING' && a.type !== 'SAVINGS' && a.type !== 'CREDIT_CARD' && a.type !== 'LINE_OF_CREDIT') {
      skipped.push(`${a.name} (${a.type})`);
      continue;
    }
    const { error: baErr } = await adminDb
      .from('bank_accounts')
      .upsert(
        {
          org_id: orgId,
          location_id: locationId,
          account_id: glAccountId,
          plaid_account_id: a.plaidAccountId,
          plaid_item_pk: itemRow.id,
          institution_name: institution.institutionName ?? 'Bank',
          account_name: a.name,
          account_mask: a.mask,
          account_type: a.type,
          current_balance_cents: a.currentBalanceCents,
          available_balance_cents: a.availableBalanceCents,
          balance_updated_at: new Date().toISOString(),
          is_active: true,
        },
        { onConflict: 'org_id,plaid_account_id' },
      );
    if (baErr) errors.push(`${a.name}: ${baErr.message}`);
    else linked += 1;
  }

  if (linked === 0) {
    throw new Error(
      `No bank accounts were linked. ${errors.length ? 'Errors: ' + errors.join('; ') : ''}` +
      `${skipped.length ? ' Skipped non-depository: ' + skipped.join(', ') : ''}` +
      ` (location=${locationId}, glAccount=${glAccountId})`,
    );
  }

  return {
    connectionId: connection.id,
    itemPk: itemRow.id,
    plaidItemId: itemId,
    institutionName: institution.institutionName,
    accountsLinked: linked,
  };
}

export interface SyncSummary {
  itemsSynced: number;
  transactionsAdded: number;
  transactionsModified: number;
  transactionsRemoved: number;
  balancesRefreshed: number;
  reauthNeeded: Array<{ plaidItemId: string; institutionName: string | null }>;
  errors: Array<{ plaidItemId: string; message: string }>;
}

/**
 * Sync all of a tenant's Plaid Items: pull transaction deltas, persist them
 * (dedupe by Plaid id), refresh balances, advance the cursor, and flag re-auth.
 * Returns a per-run summary for the UI.
 */
export async function syncAllPlaidItems(adminDb: SupabaseClient, orgId: string): Promise<SyncSummary> {
  const summary: SyncSummary = {
    itemsSynced: 0,
    transactionsAdded: 0,
    transactionsModified: 0,
    transactionsRemoved: 0,
    balancesRefreshed: 0,
    reauthNeeded: [],
    errors: [],
  };

  const { data: items, error } = await adminDb
    .from('plaid_items')
    .select('id, plaid_item_id, institution_name, sync_cursor, connection_id, status')
    .eq('org_id', orgId);
  if (error) throw new Error(`Could not list Plaid items: ${error.message}`);
  if (!items || items.length === 0) return summary;

  // A map of plaid_account_id -> our bank_accounts.id, scoped to this org.
  const { data: bankAccts } = await adminDb
    .from('bank_accounts')
    .select('id, org_id, location_id, account_id, plaid_account_id, plaid_item_pk')
    .eq('org_id', orgId);
  const acctByPlaidId = new Map<string, BankAccountRow>();
  for (const ba of (bankAccts ?? []) as BankAccountRow[]) {
    if (ba.plaid_account_id) acctByPlaidId.set(ba.plaid_account_id, ba);
  }

  for (const item of items as Array<{
    id: string; plaid_item_id: string; institution_name: string | null;
    sync_cursor: string | null; connection_id: string;
  }>) {
    let accessToken: string;
    try {
      const ctx = await resolveProviderContext(adminDb, orgId, 'BANK_FEED');
      // resolveProviderContext returns the most-recent active connection; for
      // multi-Item tenants, read this Item's token by its own connection row.
      accessToken = ctx.connection.id === item.connection_id
        ? ctx.secret
        : await readTokenForConnection(adminDb, orgId, item.connection_id);
    } catch (e) {
      summary.errors.push({ plaidItemId: item.plaid_item_id, message: e instanceof Error ? e.message : 'token unavailable' });
      continue;
    }

    try {
      const result = await syncItemTransactions(adminDb, ENV, accessToken, item.sync_cursor);

      // Persist added + modified (upsert by Plaid id -> dedupe).
      const rows = [...result.added, ...result.modified]
        .map((t) => {
          const ba = acctByPlaidId.get(t.plaidAccountId);
          if (!ba) return null; // account not linked (e.g. excluded); skip
          return {
            org_id: orgId,
            bank_account_id: ba.id,
            location_id: ba.location_id,
            plaid_transaction_id: t.plaidTransactionId,
            transaction_date: t.postedDate,
            posted_date: t.postedDate,
            description: t.description,
            amount_cents: t.amountCents,
            category: t.category,
            status: 'PENDING' as const,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      if (rows.length > 0) {
        const { error: upErr } = await adminDb
          .from('bank_transactions')
          .upsert(rows, { onConflict: 'org_id,plaid_transaction_id' });
        if (upErr) throw new Error(upErr.message);
      }

      // Removed transactions: delete by Plaid id (only those not yet posted to GL).
      if (result.removedIds.length > 0) {
        await adminDb
          .from('bank_transactions')
          .delete()
          .eq('org_id', orgId)
          .is('gl_entry_id', null)
          .in('plaid_transaction_id', result.removedIds);
      }

      // Refresh balances for this Item's accounts.
      const balances = await fetchBalances(adminDb, ENV, accessToken);
      let refreshed = 0;
      for (const [plaidAcctId, b] of Object.entries(balances)) {
        const ba = acctByPlaidId.get(plaidAcctId);
        if (!ba) continue;
        await adminDb
          .from('bank_accounts')
          .update({
            current_balance_cents: b.currentCents,
            available_balance_cents: b.availableCents,
            balance_updated_at: new Date().toISOString(),
          })
          .eq('id', ba.id);
        refreshed += 1;
      }

      // Advance the cursor + mark healthy.
      await adminDb
        .from('plaid_items')
        .update({ sync_cursor: result.nextCursor, last_synced_at: new Date().toISOString(), status: 'active', status_detail: null })
        .eq('id', item.id);

      summary.itemsSynced += 1;
      summary.transactionsAdded += result.added.length;
      summary.transactionsModified += result.modified.length;
      summary.transactionsRemoved += result.removedIds.length;
      summary.balancesRefreshed += refreshed;
    } catch (e) {
      const { message, loginRequired } = describePlaidError(e);
      await adminDb
        .from('plaid_items')
        .update({ status: loginRequired ? 'login_required' : 'error', status_detail: message })
        .eq('id', item.id);
      if (loginRequired) {
        summary.reauthNeeded.push({ plaidItemId: item.plaid_item_id, institutionName: item.institution_name });
      } else {
        summary.errors.push({ plaidItemId: item.plaid_item_id, message });
      }
    }
  }

  return summary;
}

/** Read the Vault access token for a specific connection row (multi-Item support). */
async function readTokenForConnection(adminDb: SupabaseClient, orgId: string, connectionId: string): Promise<string> {
  const { data, error } = await adminDb
    .schema('core')
    .from('provider_connections')
    .select('secret_ref')
    .eq('org_id', orgId)
    .eq('id', connectionId)
    .maybeSingle<{ secret_ref: string | null }>();
  if (error) throw new Error(error.message);
  const ref = data?.secret_ref;
  if (!ref) throw new Error('Connection has no stored credential.');
  const { readProviderSecret } = await import('@/lib/money/secrets');
  const token = await readProviderSecret(adminDb, ref);
  if (!token) throw new Error('Stored credential is unreadable.');
  return token;
}
