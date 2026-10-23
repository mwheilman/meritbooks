/**
 * GATE 12 — provider connection registry (Books consumes Core infra).
 *
 * Reads/writes core.provider_connections (Core-owned) and stores credentials in
 * Vault via lib/money/secrets. Capability availability is gated by
 * core.organizations.entitlements (Core ruling): a connected provider does NOT,
 * by itself, enable a capability — the tenant must be entitled to it. Enabling a
 * capability for a tenant is a setup action that sets the entitlement flag.
 *
 * Call with the admin (service-role) Supabase client. Secrets never leave the
 * server: returned ProviderConnection objects never include the secret value.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getEntitlements } from '@/lib/services/entitlements';
import {
  storeProviderSecret,
  readProviderSecret,
  deleteProviderSecret,
} from '@/lib/money/secrets';
import {
  type Capability,
  type ProviderConnection,
  type ProviderContext,
  type ProviderEnvironment,
  CAPABILITY_ENTITLEMENT,
} from '@/lib/money/providers/types';

const ALL_CAPABILITIES: Capability[] = ['AR_COLLECTION', 'AP_DISBURSEMENT', 'PAYROLL', 'BANK_FEED'];

export interface ConnectionRow {
  id: string;
  org_id: string;
  capability: Capability;
  provider: string;
  environment: ProviderEnvironment;
  location_id?: string | null;
  account_handle: string | null;
  secret_ref: string | null;
  status: 'active' | 'disconnected' | 'error';
  connected_by: string | null;
  status_detail: string | null;
  metadata: Record<string, unknown> | null;
  charges_enabled?: boolean | null;
  payouts_enabled?: boolean | null;
  details_submitted?: boolean | null;
  disabled_reason?: string | null;
  requirements_due?: string[] | null;
  payout_bank_name?: string | null;
  payout_bank_last4?: string | null;
  status_checked_at?: string | null;
  created_at: string;
  updated_at: string;
}

export function toConnection(r: ConnectionRow): ProviderConnection {
  return {
    id: r.id,
    orgId: r.org_id,
    capability: r.capability,
    provider: r.provider,
    environment: r.environment,
    locationId: r.location_id ?? null,
    accountHandle: r.account_handle,
    secretRef: r.secret_ref,
    status: r.status,
    connectedBy: r.connected_by,
    statusDetail: r.status_detail,
    metadata: r.metadata ?? {},
    account: {
      chargesEnabled: r.charges_enabled ?? null,
      payoutsEnabled: r.payouts_enabled ?? null,
      detailsSubmitted: r.details_submitted ?? null,
      disabledReason: r.disabled_reason ?? null,
      requirementsDue: r.requirements_due ?? [],
      payoutBankName: r.payout_bank_name ?? null,
      payoutBankLast4: r.payout_bank_last4 ?? null,
      checkedAt: r.status_checked_at ?? null,
    },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Is the tenant entitled to a capability? (Core: capability offered from entitlements.) */
export async function isCapabilityEntitled(adminDb: SupabaseClient, orgId: string, capability: Capability): Promise<boolean> {
  const ent = await getEntitlements(adminDb, orgId);
  return ent[CAPABILITY_ENTITLEMENT[capability]] === true;
}

/** All connections for a tenant (no secrets). */
export async function listConnections(adminDb: SupabaseClient, orgId: string): Promise<ProviderConnection[]> {
  const { data, error } = await adminDb
    .schema('core')
    .from('provider_connections')
    .select('*')
    .eq('org_id', orgId)
    .order('capability', { ascending: true });
  if (error) throw new Error(error.message);
  return ((data ?? []) as ConnectionRow[]).map(toConnection);
}

export interface CapabilityStatus {
  capability: Capability;
  entitled: boolean;
  connections: ProviderConnection[];
  ready: boolean; // entitled AND has an active connection
}

/** Per-capability status for a settings/status view: entitled? connected? ready? */
export async function listCapabilityStatus(adminDb: SupabaseClient, orgId: string): Promise<CapabilityStatus[]> {
  const [ent, conns] = await Promise.all([getEntitlements(adminDb, orgId), listConnections(adminDb, orgId)]);
  return ALL_CAPABILITIES.map((capability) => {
    const entitled = ent[CAPABILITY_ENTITLEMENT[capability]] === true;
    const connections = conns.filter((c) => c.capability === capability);
    const ready = entitled && connections.some((c) => c.status === 'active');
    return { capability, entitled, connections, ready };
  });
}

export class CapabilityNotEntitledError extends Error {
  constructor(capability: Capability) {
    super(`Capability ${capability} is not enabled for this tenant. Set the '${CAPABILITY_ENTITLEMENT[capability]}' entitlement first.`);
    this.name = 'CapabilityNotEntitledError';
  }
}

/**
 * Register/connect a provider for a capability. Fails closed if the tenant is not
 * entitled. Stores the credential in Vault and persists only its reference.
 *
 * Identity of a connection (migration 175): one row per (org, capability, provider,
 * environment, company) — `locationId` null = tenant-level — except BANK_FEED, where a
 * row is one Plaid Item (keyed by its account handle, so a second bank login never
 * overwrites the first one's token). The row is looked up by that key, then updated or
 * inserted; the partial unique indexes are the race guard (a concurrent insert that
 * loses retries as an update).
 */
export async function connectProvider(
  adminDb: SupabaseClient,
  orgId: string,
  input: {
    capability: Capability;
    provider: string;
    environment: ProviderEnvironment;
    locationId?: string | null;
    accountHandle?: string | null;
    secret?: string | null;
    connectedBy: string;
    metadata?: Record<string, unknown>;
  },
): Promise<ProviderConnection> {
  if (!(await isCapabilityEntitled(adminDb, orgId, input.capability))) {
    throw new CapabilityNotEntitledError(input.capability);
  }

  let secretRef: string | null = null;
  if (input.secret) {
    // Vault enforces unique secret NAMES. Include the account handle (when present)
    // and a short random suffix so re-connecting after a reset can't collide with
    // an orphaned secret left in Vault under the same logical name.
    const handlePart = input.accountHandle ? `:${input.accountHandle}` : '';
    const uniqueSuffix = Math.random().toString(36).slice(2, 8);
    const secretName = `${orgId}:${input.capability}:${input.provider}:${input.environment}${handlePart}:${uniqueSuffix}`;
    secretRef = await storeProviderSecret(adminDb, input.secret, secretName);
  }

  const locationId = input.locationId ?? null;
  const row = {
    org_id: orgId,
    capability: input.capability,
    provider: input.provider,
    environment: input.environment,
    location_id: locationId,
    account_handle: input.accountHandle ?? null,
    secret_ref: secretRef,
    status: 'active' as const,
    connected_by: input.connectedBy,
    status_detail: null,
    metadata: input.metadata ?? {},
  };

  const findExisting = async (): Promise<{ id: string; secret_ref: string | null } | null> => {
    let q = adminDb
      .schema('core')
      .from('provider_connections')
      .select('id, secret_ref')
      .eq('org_id', orgId)
      .eq('capability', input.capability)
      .eq('provider', input.provider)
      .eq('environment', input.environment);
    if (input.capability === 'BANK_FEED') {
      q = input.accountHandle ? q.eq('account_handle', input.accountHandle) : q.is('account_handle', null);
    } else {
      q = locationId ? q.eq('location_id', locationId) : q.is('location_id', null);
    }
    const { data, error } = await q.limit(1).maybeSingle<{ id: string; secret_ref: string | null }>();
    if (error) throw new Error(error.message);
    return data ?? null;
  };

  const write = async (): Promise<{ data: ConnectionRow | null; error: { message: string; code?: string } | null; replacedSecret: string | null }> => {
    const existing = await findExisting();
    if (existing) {
      const { data, error } = await adminDb
        .schema('core')
        .from('provider_connections')
        .update(row)
        .eq('org_id', orgId)
        .eq('id', existing.id)
        .select('*')
        .single();
      return { data: (data as ConnectionRow | null) ?? null, error, replacedSecret: existing.secret_ref };
    }
    const { data, error } = await adminDb
      .schema('core')
      .from('provider_connections')
      .insert(row)
      .select('*')
      .single();
    return { data: (data as ConnectionRow | null) ?? null, error, replacedSecret: null };
  };

  let res = await write();
  // Lost an insert race to a concurrent connect of the same key → update that row instead.
  if (res.error?.code === '23505') res = await write();

  if (res.error || !res.data) {
    // Don't orphan a freshly-stored secret if the row write failed.
    if (secretRef) await deleteProviderSecret(adminDb, secretRef).catch(() => undefined);
    throw new Error(res.error?.message ?? 'Could not save the connection.');
  }
  // A re-connect that replaced the stored credential: drop the old Vault secret.
  if (secretRef && res.replacedSecret && res.replacedSecret !== secretRef) {
    await deleteProviderSecret(adminDb, res.replacedSecret).catch(() => undefined);
  }
  return toConnection(res.data);
}

/** Disconnect a connection: mark disconnected and remove its Vault secret. */
export async function disconnectProvider(adminDb: SupabaseClient, orgId: string, connectionId: string): Promise<void> {
  const { data, error } = await adminDb
    .schema('core')
    .from('provider_connections')
    .select('secret_ref')
    .eq('org_id', orgId)
    .eq('id', connectionId)
    .maybeSingle<{ secret_ref: string | null }>();
  if (error) throw new Error(error.message);

  const { error: upErr } = await adminDb
    .schema('core')
    .from('provider_connections')
    .update({ status: 'disconnected', secret_ref: null })
    .eq('org_id', orgId)
    .eq('id', connectionId);
  if (upErr) throw new Error(upErr.message);

  if (data?.secret_ref) await deleteProviderSecret(adminDb, data.secret_ref).catch(() => undefined);
}

/**
 * Resolve the active connection + decrypted secret for a capability, for an
 * adapter to use. Server/service-role only. Throws if not entitled or no active
 * connection. (Adapters are built per sub-gate; this is their entry point.)
 */
export async function resolveProviderContext(
  adminDb: SupabaseClient,
  orgId: string,
  capability: Capability,
): Promise<ProviderContext> {
  if (!(await isCapabilityEntitled(adminDb, orgId, capability))) {
    throw new CapabilityNotEntitledError(capability);
  }
  const { data, error } = await adminDb
    .schema('core')
    .from('provider_connections')
    .select('*')
    .eq('org_id', orgId)
    .eq('capability', capability)
    .eq('status', 'active')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle<ConnectionRow>();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`No active ${capability} connection for this tenant.`);

  const connection = toConnection(data);
  const secret = connection.secretRef ? await readProviderSecret(adminDb, connection.secretRef) : null;
  if (!secret) throw new Error(`Connection ${connection.id} has no usable credential.`);
  return { connection, secret };
}
