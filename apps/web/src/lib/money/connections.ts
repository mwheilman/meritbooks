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

interface ConnectionRow {
  id: string;
  org_id: string;
  capability: Capability;
  provider: string;
  environment: ProviderEnvironment;
  account_handle: string | null;
  secret_ref: string | null;
  status: 'active' | 'disconnected' | 'error';
  connected_by: string | null;
  status_detail: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

function toConnection(r: ConnectionRow): ProviderConnection {
  return {
    id: r.id,
    orgId: r.org_id,
    capability: r.capability,
    provider: r.provider,
    environment: r.environment,
    accountHandle: r.account_handle,
    secretRef: r.secret_ref,
    status: r.status,
    connectedBy: r.connected_by,
    statusDetail: r.status_detail,
    metadata: r.metadata ?? {},
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
 */
export async function connectProvider(
  adminDb: SupabaseClient,
  orgId: string,
  input: {
    capability: Capability;
    provider: string;
    environment: ProviderEnvironment;
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
    secretRef = await storeProviderSecret(adminDb, input.secret, `${orgId}:${input.capability}:${input.provider}:${input.environment}`);
  }

  const { data, error } = await adminDb
    .schema('core')
    .from('provider_connections')
    .upsert(
      {
        org_id: orgId,
        capability: input.capability,
        provider: input.provider,
        environment: input.environment,
        account_handle: input.accountHandle ?? null,
        secret_ref: secretRef,
        status: 'active',
        connected_by: input.connectedBy,
        status_detail: null,
        metadata: input.metadata ?? {},
      },
      { onConflict: 'org_id,capability,provider,environment' },
    )
    .select('*')
    .single();

  if (error) {
    // Don't orphan a freshly-stored secret if the row write failed.
    if (secretRef) await deleteProviderSecret(adminDb, secretRef).catch(() => undefined);
    throw new Error(error.message);
  }
  return toConnection(data as ConnectionRow);
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
