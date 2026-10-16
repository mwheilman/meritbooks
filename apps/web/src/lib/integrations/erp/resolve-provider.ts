/**
 * resolveMigrationProvider — the PER-ORG way to get a migration adapter.
 *
 * `getMigrationProvider(id, { mock })` (providers/index.ts) is synchronous and
 * org-blind, so it can only ever return the mock or a not-connected real adapter.
 * Routes that pull a tenant's books should call THIS instead:
 *
 *   const r = await resolveMigrationProvider(erpId, { orgId, mock: !!useFixture });
 *   const tb = await r.provider.fetchTrialBalance();
 *
 * It applies the explicit selection rule (providers/selection.ts): live only for a
 * connected QBO org; mock only on explicit request outside production; otherwise an
 * honest not-connected adapter. Server-only (uses the admin client to read Vault).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { sampleImportsAllowed } from '@/lib/onboarding/sample-guard';
import { MockConnectorProvider } from './providers/mock';
import { RealConnectorProvider } from './providers/real';
import {
  isProductionRuntime,
  selectMigrationProvider,
  type ProviderSelection,
} from './providers/selection';
import type { ConnectorProvider, MigrationProviderId } from './providers/types';
import { QboClient } from './quickbooks/client';
import { readQboConfig } from './quickbooks/config';
import { createVaultTokenStore, loadQboConnection } from './quickbooks/connection-store';
import { QboLiveSource } from './quickbooks/live-source';
import type { FetchLike } from './quickbooks/oauth';
import { QboTokenManager } from './quickbooks/token-manager';

export interface ResolveProviderOptions {
  /** The RESOLVED Books tenant (from requirePermission / requireAuth). */
  orgId: string;
  /** Caller explicitly asked for sample data. Refused in production. */
  mock?: boolean;
  /** Opening-balance date for the trial balance (YYYY-MM-DD). */
  asOfDate?: string | null;
  env?: NodeJS.ProcessEnv;
  /** Injected for tests; defaults to the service-role client. */
  admin?: SupabaseClient;
  fetchImpl?: FetchLike;
}

export interface ResolvedProvider {
  provider: ConnectorProvider;
  selection: ProviderSelection;
  /** Present only for a live QBO org — exposes CompanyInfo + pre-flight. */
  qbo: QboLiveSource | null;
}

export async function resolveMigrationProvider(
  id: MigrationProviderId,
  opts: ResolveProviderOptions,
): Promise<ResolvedProvider> {
  const env = opts.env ?? process.env;
  const config = id === 'quickbooks' ? readQboConfig(env) : null;

  let admin: SupabaseClient | null = opts.admin ?? null;
  let connectionStatus: 'connected' | 'pending' | 'error' | null = null;
  let connectionError: string | null = null;

  if (id === 'quickbooks' && config && !opts.mock) {
    if (!admin) {
      const { createAdminSupabase } = await import('@/lib/supabase/server');
      admin = createAdminSupabase();
    }
    try {
      const rec = await loadQboConnection(admin, opts.orgId);
      connectionStatus = rec?.status ?? null;
      connectionError = rec?.meta?.lastError ?? null;
    } catch {
      connectionStatus = null;
    }
  }

  const selection = selectMigrationProvider({
    providerId: id,
    requestedMock: !!opts.mock,
    // ONE rule for "may sample data serve this request": the sample guard (stricter
    // production test — previews count — plus the explicit flag / sandbox-org
    // allowlist). Keeps the route-level `sampleImportRequestBlock` and this adapter
    // choice from ever disagreeing.
    isProduction: isProductionRuntime(env) && !sampleImportsAllowed({ orgId: opts.orgId, env }),
    qboConfigured: config !== null,
    connectionStatus,
    connectionError,
  });

  if (selection.kind === 'mock') {
    return { provider: new MockConnectorProvider(id), selection, qbo: null };
  }
  if (selection.kind === 'live' && config && admin) {
    const tokens = new QboTokenManager(
      `qbo:${opts.orgId}`,
      config,
      createVaultTokenStore(admin, opts.orgId),
      opts.fetchImpl,
    );
    const client = new QboClient({ environment: config.environment, tokens, fetchImpl: opts.fetchImpl });
    const qbo = new QboLiveSource(client, { asOfDate: opts.asOfDate ?? null });
    return { provider: new RealConnectorProvider(id, env, { live: qbo }), selection, qbo };
  }
  const reason = selection.kind === 'live' ? null : selection.reason;
  return {
    provider: new RealConnectorProvider(id, env, { notConnectedReason: reason }),
    selection,
    qbo: null,
  };
}
