/**
 * Persistence for a tenant's QuickBooks connection.
 *
 * Secret-storage pattern REUSED from GATE 12 (Plaid): the token set is stored
 * ENCRYPTED in Supabase Vault via the service-role-only RPCs from migrations 041/047
 * (`lib/money/secrets.ts`). The `core.erp_connections` row (migration 108) holds only
 * NON-SECRET data in `meta`: the Vault reference (`secretRef`, a uuid pointer that is
 * useless without service_role), the realmId, environment, refresh-token hard expiry,
 * and the last plain-English error. Tenants can read their row via RLS; they can
 * never read the tokens. No new table or migration is required.
 *
 * Every function here MUST be called with the ADMIN (service-role) client, from
 * server code, AFTER the route's settings_system permission gate.
 */

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  deleteProviderSecret,
  readProviderSecret,
  rotateProviderSecret,
  storeProviderSecret,
} from '@/lib/money/secrets';
import { QBO_ERP_ID, type QboEnvironment } from './config';
import type { QboTokenSet } from './oauth';
import type { QboTokenStore } from './token-manager';

const SCHEMA = 'core';
const TABLE = 'erp_connections';

/** Non-secret metadata kept on the connection row. */
export interface QboConnectionMeta {
  provider: 'quickbooks';
  realmId: string;
  secretRef: string;
  environment: QboEnvironment;
  connectedBy: string | null;
  refreshExpiresAt: string | null;
  lastError: string | null;
  disconnectedAt?: string | null;
}

export interface QboConnectionRecord {
  id: string;
  orgId: string;
  status: 'connected' | 'pending' | 'error';
  companyName: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
  meta: QboConnectionMeta | null;
}

interface Row {
  id: string;
  org_id: string;
  status: string;
  external_account_label: string | null;
  meta: Record<string, unknown> | null;
  connected_at: string | null;
  last_sync_at: string | null;
}

// ── Pure (de)serialization — unit-tested ─────────────────────────────────────

export function serializeTokens(t: QboTokenSet): string {
  return JSON.stringify({
    v: 1,
    a: t.accessToken,
    r: t.refreshToken,
    ae: t.accessExpiresAt,
    re: t.refreshExpiresAt,
    realm: t.realmId,
  });
}

export function parseTokens(raw: string | null): QboTokenSet | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (typeof o.a !== 'string' || typeof o.r !== 'string' || typeof o.realm !== 'string') return null;
    return {
      accessToken: o.a,
      refreshToken: o.r,
      accessExpiresAt: typeof o.ae === 'number' ? o.ae : 0,
      refreshExpiresAt: typeof o.re === 'number' ? o.re : null,
      realmId: o.realm,
    };
  } catch {
    return null;
  }
}

export function parseQboMeta(meta: Record<string, unknown> | null | undefined): QboConnectionMeta | null {
  if (!meta || typeof meta !== 'object') return null;
  if (typeof meta.secretRef !== 'string' || typeof meta.realmId !== 'string') return null;
  return {
    provider: 'quickbooks',
    realmId: meta.realmId,
    secretRef: meta.secretRef,
    environment: meta.environment === 'production' ? 'production' : 'sandbox',
    connectedBy: typeof meta.connectedBy === 'string' ? meta.connectedBy : null,
    refreshExpiresAt: typeof meta.refreshExpiresAt === 'string' ? meta.refreshExpiresAt : null,
    lastError: typeof meta.lastError === 'string' ? meta.lastError : null,
  };
}

// ── DB access (admin client) ─────────────────────────────────────────────────

export async function loadQboConnection(
  admin: SupabaseClient,
  orgId: string,
): Promise<QboConnectionRecord | null> {
  const { data, error } = await admin
    .schema(SCHEMA)
    .from(TABLE)
    .select('id, org_id, status, external_account_label, meta, connected_at, last_sync_at')
    .eq('org_id', orgId)
    .eq('erp_id', QBO_ERP_ID)
    .maybeSingle();
  if (error) throw new Error(`Could not load QuickBooks connection: ${error.message}`);
  if (!data) return null;
  const row = data as Row;
  const status = (['connected', 'pending', 'error'] as const).find((s) => s === row.status) ?? 'pending';
  return {
    id: row.id,
    orgId: row.org_id,
    status,
    companyName: row.external_account_label,
    connectedAt: row.connected_at,
    lastSyncAt: row.last_sync_at,
    meta: parseQboMeta(row.meta),
  };
}

async function updateRow(
  admin: SupabaseClient,
  orgId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await admin
    .schema(SCHEMA)
    .from(TABLE)
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('erp_id', QBO_ERP_ID);
  if (error) throw new Error(`Could not update QuickBooks connection: ${error.message}`);
}

/**
 * Store tokens (Vault) and mark the org's QBO row connected. Re-connecting reuses the
 * existing Vault secret (rotate in place) so we never orphan an old token.
 */
export async function saveQboConnection(
  admin: SupabaseClient,
  input: {
    orgId: string;
    tokens: QboTokenSet;
    companyName: string | null;
    userId: string;
    environment: QboEnvironment;
  },
): Promise<void> {
  const existing = await loadQboConnection(admin, input.orgId);
  const secret = serializeTokens(input.tokens);

  let secretRef: string;
  if (existing?.meta?.secretRef) {
    secretRef = existing.meta.secretRef;
    await rotateProviderSecret(admin, secretRef, secret);
  } else {
    secretRef = await storeProviderSecret(admin, secret, `qbo:${input.orgId}:${randomUUID()}`);
  }

  const meta: QboConnectionMeta = {
    provider: 'quickbooks',
    realmId: input.tokens.realmId,
    secretRef,
    environment: input.environment,
    connectedBy: input.userId,
    refreshExpiresAt: input.tokens.refreshExpiresAt
      ? new Date(input.tokens.refreshExpiresAt).toISOString()
      : null,
    lastError: null,
  };
  const now = new Date().toISOString();
  const { error } = await admin
    .schema(SCHEMA)
    .from(TABLE)
    .upsert(
      {
        org_id: input.orgId,
        erp_id: QBO_ERP_ID,
        method: 'OAUTH',
        status: 'connected',
        external_account_label: input.companyName,
        meta,
        connected_at: now,
        updated_at: now,
      },
      { onConflict: 'org_id,erp_id' },
    );
  if (error) {
    // Don't leave an unreferenced secret behind on a brand-new connection.
    if (!existing?.meta?.secretRef) await deleteProviderSecret(admin, secretRef).catch(() => undefined);
    throw new Error(`Could not save QuickBooks connection: ${error.message}`);
  }
}

/** Record a successful pull. Best-effort. */
export async function touchQboLastSync(admin: SupabaseClient, orgId: string): Promise<void> {
  await updateRow(admin, orgId, { last_sync_at: new Date().toISOString() }).catch(() => undefined);
}

/**
 * Read the stored token set for an org (so disconnect can revoke it at Intuit
 * before deleting our copy). Returns tokens:null when nothing is stored.
 */
export async function readQboTokensForOrg(
  admin: SupabaseClient,
  orgId: string,
): Promise<{ record: QboConnectionRecord | null; tokens: QboTokenSet | null }> {
  const record = await loadQboConnection(admin, orgId);
  if (!record?.meta?.secretRef) return { record, tokens: null };
  const raw = await readProviderSecret(admin, record.meta.secretRef);
  return { record, tokens: parseTokens(raw) };
}

/** Delete our copy of the tokens (Vault) and the connection row. */
export async function deleteQboConnection(
  admin: SupabaseClient,
  record: QboConnectionRecord,
): Promise<void> {
  if (record.meta?.secretRef) await deleteProviderSecret(admin, record.meta.secretRef);
  const { error } = await admin
    .schema(SCHEMA)
    .from(TABLE)
    .delete()
    .eq('org_id', record.orgId)
    .eq('erp_id', QBO_ERP_ID);
  if (error) throw new Error(`Could not remove QuickBooks connection: ${error.message}`);
}

/** The production QboTokenStore: Vault for secrets, the row for status. */
export function createVaultTokenStore(admin: SupabaseClient, orgId: string): QboTokenStore {
  let secretRef: string | null = null;
  let meta: QboConnectionMeta | null = null;
  return {
    async load() {
      const record = await loadQboConnection(admin, orgId);
      if (!record || record.status === 'error' || !record.meta) return null;
      meta = record.meta;
      secretRef = record.meta.secretRef;
      const tokens = parseTokens(await readProviderSecret(admin, secretRef));
      // Defense in depth: the token must belong to the realm on this org's row.
      if (!tokens || tokens.realmId !== record.meta.realmId) return null;
      return tokens;
    },
    async save(tokens) {
      if (!secretRef || !meta) throw new Error('QuickBooks token store used before load()');
      await rotateProviderSecret(admin, secretRef, serializeTokens(tokens));
      const nextMeta: QboConnectionMeta = {
        ...meta,
        refreshExpiresAt: tokens.refreshExpiresAt ? new Date(tokens.refreshExpiresAt).toISOString() : meta.refreshExpiresAt,
        lastError: null,
      };
      meta = nextMeta;
      await updateRow(admin, orgId, { meta: nextMeta });
    },
    async markError(message) {
      const record = await loadQboConnection(admin, orgId).catch(() => null);
      const base = record?.meta ?? meta;
      await updateRow(admin, orgId, {
        status: 'error',
        meta: base ? { ...base, lastError: message } : { provider: 'quickbooks', lastError: message },
      }).catch(() => undefined);
    },
  };
}
