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

export interface ConnectResult {
  connectionId: string;
  itemPk: string;
  plaidItemId: string;
  institutionName: string | null;
  accountsStaged: number;
}

/**
 * Complete a Link flow for a KNOWN entity: exchange the public token, register
 * the connection, record the Item, and stage the returned accounts under the
 * given location. The entity is resolved before Plaid opens (presumed when
 * scoped to a company; picked once from the consolidated view) — never guessed.
 */
export async function completePlaidLink(
  adminDb: SupabaseClient,
  orgId: string,
  input: { publicToken: string; connectedBy: string; locationId: string },
): Promise<ConnectResult> {
  // Validate the entity belongs to this org.
  const { data: locRow } = await adminDb
    .schema('core')
    .from('locations')
    .select('id')
    .eq('org_id', orgId)
    .eq('id', input.locationId)
    .maybeSingle<{ id: string }>();
  if (!locRow) throw new Error('Selected entity not found for this tenant.');

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

  // 2b) Repeat-connect hardening (Session 25): clear any prior PENDING staged
  //     rows for THIS Item before re-staging. Reconnecting the same institution
  //     used to leave stale PENDING rows behind, so the mapper appeared to list
  //     accounts "twice". Only PENDING rows are removed — accounts already mapped
  //     (promoted to bank_accounts, status no longer PENDING) are untouched.
  await adminDb
    .from('plaid_pending_accounts')
    .delete()
    .eq('org_id', orgId)
    .eq('plaid_item_pk', itemRow.id)
    .eq('status', 'PENDING');

  // 3) Stage every returned account under the resolved entity. The user then
  //    assigns each a GL account + label (entity is already known) before it
  //    becomes a real bank account. We do NOT auto-create bank_accounts here.
  const staged: Array<{ plaidAccountId: string; name: string; type: string }> = [];
  for (const a of accounts) {
    const { error: stErr } = await adminDb
      .from('plaid_pending_accounts')
      .upsert(
        {
          org_id: orgId,
          plaid_item_pk: itemRow.id,
          connection_id: connection.id,
          location_id: input.locationId,
          plaid_account_id: a.plaidAccountId,
          account_name: a.name,
          account_mask: a.mask,
          account_type: a.type,
          current_balance_cents: a.currentBalanceCents,
          available_balance_cents: a.availableBalanceCents,
          status: 'PENDING',
        },
        { onConflict: 'org_id,plaid_account_id' },
      );
    if (!stErr) staged.push({ plaidAccountId: a.plaidAccountId, name: a.name, type: a.type });
  }

  return {
    connectionId: connection.id,
    itemPk: itemRow.id,
    plaidItemId: itemId,
    institutionName: institution.institutionName,
    accountsStaged: staged.length,
  };
}

export interface PendingAccount {
  id: string;
  plaidAccountId: string;
  accountName: string;
  accountMask: string | null;
  accountType: string;
  currentBalanceCents: number | null;
  locationId: string;
  status: string;
}

/** List the accounts awaiting mapping for a tenant (newest connect first). */
export async function listPendingAccounts(adminDb: SupabaseClient, orgId: string): Promise<PendingAccount[]> {
  const { data, error } = await adminDb
    .from('plaid_pending_accounts')
    .select('id, plaid_account_id, account_name, account_mask, account_type, current_balance_cents, location_id, status')
    .eq('org_id', orgId)
    .eq('status', 'PENDING')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    plaidAccountId: r.plaid_account_id as string,
    accountName: r.account_name as string,
    accountMask: (r.account_mask as string | null) ?? null,
    accountType: r.account_type as string,
    currentBalanceCents: (r.current_balance_cents as number | null) ?? null,
    locationId: r.location_id as string,
    status: r.status as string,
  }));
}

/**
 * Promote a staged account into a real bank account. The entity is taken from
 * the staged row (resolved before Plaid opened); the user supplies only the GL
 * cash account and a label. Idempotent on (org, plaid_account_id).
 */
export async function mapPendingAccount(
  adminDb: SupabaseClient,
  orgId: string,
  input: { pendingId: string; glAccountId: string; label: string },
): Promise<{ bankAccountId: string }> {
  // Load the staged row (includes the entity it was connected under).
  const { data: pend, error: pErr } = await adminDb
    .from('plaid_pending_accounts')
    .select('id, plaid_account_id, plaid_item_pk, location_id, account_mask, account_type, current_balance_cents, available_balance_cents')
    .eq('org_id', orgId)
    .eq('id', input.pendingId)
    .maybeSingle<{
      id: string; plaid_account_id: string; plaid_item_pk: string; location_id: string; account_mask: string | null;
      account_type: string; current_balance_cents: number | null; available_balance_cents: number | null;
    }>();
  if (pErr) throw new Error(pErr.message);
  if (!pend) throw new Error('Pending account not found.');

  // Validate the chosen GL account belongs to this org.
  const { data: gl } = await adminDb
    .from('accounts')
    .select('id')
    .eq('org_id', orgId)
    .eq('id', input.glAccountId)
    .maybeSingle<{ id: string }>();
  if (!gl) throw new Error('Chosen GL account not found for this tenant.');

  // Resolve institution name from the item.
  const { data: item } = await adminDb
    .from('plaid_items')
    .select('institution_name')
    .eq('id', pend.plaid_item_pk)
    .maybeSingle<{ institution_name: string | null }>();

  const fields = {
    org_id: orgId,
    location_id: pend.location_id,
    account_id: input.glAccountId,
    plaid_account_id: pend.plaid_account_id,
    plaid_item_pk: pend.plaid_item_pk,
    institution_name: item?.institution_name ?? 'Bank',
    account_name: input.label.trim() || 'Bank Account',
    account_mask: pend.account_mask,
    account_type: pend.account_type === 'OTHER' ? 'CHECKING' : pend.account_type,
    current_balance_cents: pend.current_balance_cents,
    available_balance_cents: pend.available_balance_cents,
    balance_updated_at: new Date().toISOString(),
    is_active: true,
  };

  const { data: existing } = await adminDb
    .from('bank_accounts')
    .select('id')
    .eq('org_id', orgId)
    .eq('plaid_account_id', pend.plaid_account_id)
    .maybeSingle<{ id: string }>();

  let bankAccountId: string;
  if (existing) {
    const { error } = await adminDb.from('bank_accounts').update(fields).eq('id', existing.id);
    if (error) throw new Error(error.message);
    bankAccountId = existing.id;
  } else {
    const { data: ins, error } = await adminDb.from('bank_accounts').insert(fields).select('id').single<{ id: string }>();
    if (error) throw new Error(error.message);
    bankAccountId = ins.id;
  }

  // Mark the staged row mapped.
  await adminDb
    .from('plaid_pending_accounts')
    .update({ status: 'MAPPED', mapped_bank_account_id: bankAccountId })
    .eq('id', pend.id);

  // Reset this Item's sync cursor so the NEXT sync re-pulls the full transaction
  // history and attaches it to all now-mapped accounts. Without this, an earlier
  // sync may have advanced the cursor before this account existed, so its
  // transactions would never be fetched. The transaction upsert is deduped by
  // plaid_transaction_id, so re-pulling is safe.
  await adminDb
    .from('plaid_items')
    .update({ sync_cursor: null })
    .eq('id', pend.plaid_item_pk);

  return { bankAccountId };
}

/** Mark a staged account as ignored (e.g. a personal/loan account the tenant won't track). */
export async function ignorePendingAccount(adminDb: SupabaseClient, orgId: string, pendingId: string): Promise<void> {
  const { error } = await adminDb
    .from('plaid_pending_accounts')
    .update({ status: 'IGNORED' })
    .eq('org_id', orgId)
    .eq('id', pendingId);
  if (error) throw new Error(error.message);
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
        // The (org_id, plaid_transaction_id) unique index is PARTIAL, so ON
        // CONFLICT can't use it. Find which Plaid ids already exist, update those,
        // insert the rest.
        const ids = rows.map((r) => r.plaid_transaction_id);
        const { data: existingTxns } = await adminDb
          .from('bank_transactions')
          .select('id, plaid_transaction_id')
          .eq('org_id', orgId)
          .in('plaid_transaction_id', ids);
        const idToPk = new Map<string, string>();
        for (const e of (existingTxns ?? []) as Array<{ id: string; plaid_transaction_id: string }>) {
          idToPk.set(e.plaid_transaction_id, e.id);
        }

        const toInsert = rows.filter((r) => !idToPk.has(r.plaid_transaction_id));
        const toUpdate = rows.filter((r) => idToPk.has(r.plaid_transaction_id));

        if (toInsert.length > 0) {
          const { error: insErr } = await adminDb.from('bank_transactions').insert(toInsert);
          if (insErr) throw new Error(insErr.message);
        }
        for (const r of toUpdate) {
          const pk = idToPk.get(r.plaid_transaction_id)!;
          // Only update fields that can legitimately change; never clobber a row
          // already posted to the GL beyond its descriptive fields.
          await adminDb
            .from('bank_transactions')
            .update({ description: r.description, amount_cents: r.amount_cents, category: r.category, posted_date: r.posted_date })
            .eq('id', pk)
            .is('gl_entry_id', null);
        }
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

/**
 * Rename a bank account and/or reselect its GL cash account (in-feed edit).
 * Only the label and GL mapping are editable; the entity stays fixed (changing
 * which entity a bank account belongs to is a separate, deliberate action).
 */
export async function updateBankAccount(
  adminDb: SupabaseClient,
  orgId: string,
  input: { bankAccountId: string; label?: string; glAccountId?: string },
): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (input.label !== undefined) {
    const trimmed = input.label.trim();
    if (!trimmed) throw new Error('Label cannot be empty.');
    patch.account_name = trimmed;
  }
  if (input.glAccountId !== undefined) {
    const { data: gl } = await adminDb
      .from('accounts')
      .select('id')
      .eq('org_id', orgId)
      .eq('id', input.glAccountId)
      .maybeSingle<{ id: string }>();
    if (!gl) throw new Error('Chosen GL account not found for this tenant.');
    patch.account_id = input.glAccountId;
  }
  if (Object.keys(patch).length === 0) return;

  const { error } = await adminDb
    .from('bank_accounts')
    .update(patch)
    .eq('org_id', orgId)
    .eq('id', input.bankAccountId);
  if (error) throw new Error(error.message);
}
