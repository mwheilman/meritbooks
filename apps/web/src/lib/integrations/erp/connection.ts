/**
 * ErpConnection — the per-tenant record that a MeritBooks org has (or wants) a link
 * to an external operational system.
 *
 * IMPORTANT — no secrets here. This concept records the EXISTENCE, STATUS, and a
 * human LABEL of a connection plus opaque `meta` (e.g. an aggregator connection
 * handle, a requested-ERP name). Raw credentials — API keys, OAuth refresh tokens —
 * are NEVER stored on this row. When real sync lands, the connector's secret lives
 * in the platform secret store (see the module report), and this row holds only a
 * reference to it. Storing a token in a plain column would be a fintech-grade leak.
 *
 * DEGRADE-SAFE: the backing table (`core.erp_connections`, RLS via get_org_id()) is
 * a REPORTED migration the lead applies to Supabase first. Until it exists, every
 * helper here resolves to an "unprovisioned" result and the UI shows the catalog +
 * CSV/skip without recording anything. Nothing throws on a missing table.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ErpConnectionMethod } from './catalog';

export type ErpConnectionStatus = 'connected' | 'pending' | 'error';

/** A row of `core.erp_connections` (or the app-shaped view of it). */
export interface ErpConnection {
  id: string;
  orgId: string;
  erpId: string;
  method: ErpConnectionMethod;
  status: ErpConnectionStatus;
  /** Human label for the linked account, e.g. "Acme — ServiceTitan tenant 4821". */
  externalAccountLabel: string | null;
  /** Opaque, NON-SECRET metadata (aggregator handle, requested name, notes). */
  meta: Record<string, unknown>;
  connectedAt: string | null;
  lastSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Result of loading connections — `provisioned:false` means the table is absent. */
export interface ErpConnectionLoad {
  provisioned: boolean;
  connections: ErpConnection[];
}

/** DB row shape (snake_case) as returned by PostgREST. */
interface ErpConnectionRow {
  id: string;
  org_id: string;
  erp_id: string;
  method: string;
  status: string;
  external_account_label: string | null;
  meta: Record<string, unknown> | null;
  connected_at: string | null;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

const ERP_CONNECTIONS_TABLE = 'erp_connections';
const ERP_CONNECTIONS_SCHEMA = 'core';

/**
 * True when a PostgREST/Postgres error indicates the table/relation does not exist
 * yet — the signal to DEGRADE SAFE rather than surface an error to the user.
 * Covers Postgres `42P01` (undefined_table) and PostgREST `PGRST205` (table not
 * found in schema cache), plus the textual fallbacks.
 */
export function isMissingErpTableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; message?: string };
  if (e.code === '42P01' || e.code === 'PGRST205') return true;
  const msg = (e.message ?? '').toLowerCase();
  return (
    msg.includes('does not exist') ||
    msg.includes('schema cache') ||
    msg.includes('could not find the table')
  );
}

function toErpConnection(row: ErpConnectionRow): ErpConnection {
  const method = row.method as ErpConnectionMethod;
  const status = (['connected', 'pending', 'error'] as const).includes(
    row.status as ErpConnectionStatus,
  )
    ? (row.status as ErpConnectionStatus)
    : 'pending';
  return {
    id: row.id,
    orgId: row.org_id,
    erpId: row.erp_id,
    method,
    status,
    externalAccountLabel: row.external_account_label,
    meta: row.meta ?? {},
    connectedAt: row.connected_at,
    lastSyncAt: row.last_sync_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Load an org's ERP connections. RLS scopes rows to the org when `supabase` is the
 * user-scoped client; the admin client should always pass `orgId` to scope
 * explicitly. Never throws — a missing table returns `provisioned:false`.
 */
export async function listErpConnections(
  supabase: SupabaseClient,
  orgId: string | null,
): Promise<ErpConnectionLoad> {
  let query = supabase
    .schema(ERP_CONNECTIONS_SCHEMA)
    .from(ERP_CONNECTIONS_TABLE)
    .select(
      'id, org_id, erp_id, method, status, external_account_label, meta, connected_at, last_sync_at, created_at, updated_at',
    )
    .order('created_at', { ascending: false });
  if (orgId) query = query.eq('org_id', orgId);

  const { data, error } = await query;
  if (error) {
    if (isMissingErpTableError(error)) return { provisioned: false, connections: [] };
    throw error;
  }
  return {
    provisioned: true,
    connections: (data as ErpConnectionRow[] | null)?.map(toErpConnection) ?? [],
  };
}

export interface UpsertErpConnectionInput {
  orgId: string;
  erpId: string;
  method: ErpConnectionMethod;
  status: ErpConnectionStatus;
  externalAccountLabel?: string | null;
  meta?: Record<string, unknown>;
  /** Set connected_at = now() when the link is considered live (MANUAL, or a real
   *  future handshake). */
  markConnected?: boolean;
}

/** Result of recording an intent/connection — `recorded:false` = table absent. */
export interface UpsertErpConnectionResult {
  recorded: boolean;
  connection: ErpConnection | null;
}

/**
 * Record (or update) an ERP connection intent for an org. One live row per
 * (org, erp) is enforced by the table's unique index; this upserts on that key so a
 * repeated "connect" is idempotent. Writes go through whatever client is passed —
 * routes use the admin client AFTER an app-layer settings_system:edit gate, matching
 * the membership_invitations pattern. Never throws on a missing table.
 */
export async function upsertErpConnection(
  supabase: SupabaseClient,
  input: UpsertErpConnectionInput,
): Promise<UpsertErpConnectionResult> {
  const payload = {
    org_id: input.orgId,
    erp_id: input.erpId,
    method: input.method,
    status: input.status,
    external_account_label: input.externalAccountLabel ?? null,
    meta: input.meta ?? {},
    connected_at: input.markConnected ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .schema(ERP_CONNECTIONS_SCHEMA)
    .from(ERP_CONNECTIONS_TABLE)
    .upsert(payload, { onConflict: 'org_id,erp_id' })
    .select(
      'id, org_id, erp_id, method, status, external_account_label, meta, connected_at, last_sync_at, created_at, updated_at',
    )
    .maybeSingle();

  if (error) {
    if (isMissingErpTableError(error)) return { recorded: false, connection: null };
    throw error;
  }
  return {
    recorded: true,
    connection: data ? toErpConnection(data as ErpConnectionRow) : null,
  };
}
