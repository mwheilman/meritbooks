/**
 * Credential-gated REAL migration adapters (QuickBooks Online / Xero / Sage).
 *
 * DEGRADE-SAFE by contract: every fetch resolves to a NotConnectedResult — it never
 * throws — when there is no live source for this org:
 *   1. The platform isn't configured for the provider (no app keys), or
 *   2. The org hasn't connected its company yet (or the connection is in error), or
 *   3. The live pull itself failed (Intuit down, throttled past budget, revoked) —
 *      surfaced as a plain-English reason, never a stack trace.
 *
 * QuickBooks Online is LIVE (slice W6): `resolveMigrationProvider` (../resolve-provider.ts)
 * builds a per-org `LiveRawSource` (quickbooks/live-source.ts) from the org's
 * Vault-stored OAuth tokens and passes it in here. `liveFetch` hands the raw,
 * fixture-shaped records to the SAME transforms the mock adapter uses — the mapping
 * profiles are never bypassed. Xero / Sage remain not-connected (guided export).
 */

import {
  transformAccount,
  transformOpenItem,
  transformParty,
  transformTrialBalanceRow,
  type RawRecord,
} from './mapping';
import {
  readMigrationCredentials,
  type ConnectorProvider,
  type FetchResult,
  type MigrationCredentials,
  type MigrationEntity,
  type MigrationProviderId,
  type ProviderAccount,
  type ProviderOpenItem,
  type ProviderParty,
  type ProviderTrialBalanceRow,
} from './types';
import { readQboConfig } from '../quickbooks/config';

const ALL_ENTITIES: MigrationEntity[] = [
  'accounts',
  'customers',
  'vendors',
  'open_ar',
  'open_ap',
  'trial_balance',
];

const PROVIDER_LABEL: Record<MigrationProviderId, string> = {
  quickbooks: 'QuickBooks Online',
  xero: 'Xero',
  sage: 'Sage',
};

/**
 * A per-org live puller that returns PROVIDER-NATIVE raw records (the same shape as
 * fixtures.ts) for one entity. Implemented for QBO by quickbooks/live-source.ts.
 */
export interface LiveRawSource {
  fetchRaw(entity: MigrationEntity): Promise<RawRecord[]>;
}

/**
 * Live raw fetch. Returns null when there is no live source (→ NotConnectedResult).
 * Env-only credentials (legacy `*_ACCESS_TOKEN` seam) are never used to call a
 * provider: per-tenant OAuth tokens are the only supported live path.
 */
async function liveFetch(
  live: LiveRawSource | null,
  entity: MigrationEntity,
): Promise<RawRecord[] | null> {
  if (!live) return null;
  return live.fetchRaw(entity);
}

export interface RealProviderOptions {
  /** The org's live source (set only when the org has a connected, valid link). */
  live?: LiveRawSource | null;
  /** Reason to show when `live` is absent (e.g. "Reconnect QuickBooks"). */
  notConnectedReason?: string | null;
}

export class RealConnectorProvider implements ConnectorProvider {
  readonly id: MigrationProviderId;
  private readonly creds: MigrationCredentials | null;
  private readonly appConfigured: boolean;
  private readonly live: LiveRawSource | null;
  private readonly notConnectedReason: string | null;

  constructor(
    id: MigrationProviderId,
    env: NodeJS.ProcessEnv = process.env,
    opts: RealProviderOptions = {},
  ) {
    this.id = id;
    this.creds = readMigrationCredentials(id, env);
    this.appConfigured = id === 'quickbooks' && readQboConfig(env) !== null;
    this.live = opts.live ?? null;
    this.notConnectedReason = opts.notConnectedReason ?? null;
  }

  listEntities(): MigrationEntity[] {
    return [...ALL_ENTITIES];
  }

  /** True when the platform can run this provider's live connect (app keys present). */
  hasCredentials(): boolean {
    return this.creds !== null || this.appConfigured;
  }

  /** True when this instance has a per-org live source (the org is connected). */
  isLive(): boolean {
    return this.live !== null;
  }

  private notConnected<T>(): FetchResult<T> {
    if (this.notConnectedReason) return { connected: false, reason: this.notConnectedReason };
    if (this.appConfigured) {
      return {
        connected: false,
        reason: `Not connected — click “Connect ${PROVIDER_LABEL[this.id]}” to link your company first.`,
      };
    }
    if (!this.creds) {
      return {
        connected: false,
        reason: `Not connected — add ${PROVIDER_LABEL[this.id]} OAuth credentials to enable live import.`,
      };
    }
    return {
      connected: false,
      reason: `${PROVIDER_LABEL[this.id]} credentials are configured, but the live sync client is not enabled in this build yet.`,
    };
  }

  private async fetchEntity<T>(
    entity: MigrationEntity,
    transform: (raw: RawRecord) => T,
  ): Promise<FetchResult<T>> {
    let raw: RawRecord[] | null;
    try {
      raw = await liveFetch(this.live, entity);
    } catch (err) {
      // Degrade-safe: a live failure is a not-connected result with a plain reason.
      return {
        connected: false,
        reason:
          err instanceof Error && err.message
            ? err.message
            : `Couldn’t read from ${PROVIDER_LABEL[this.id]} right now. Please try again.`,
      };
    }
    if (raw === null) return this.notConnected<T>();
    return { connected: true, source: 'live', entity, records: raw.map(transform) };
  }

  fetchTrialBalance(): Promise<FetchResult<ProviderTrialBalanceRow>> {
    return this.fetchEntity('trial_balance', (r) => transformTrialBalanceRow(this.id, r));
  }

  fetchAccounts(): Promise<FetchResult<ProviderAccount>> {
    return this.fetchEntity('accounts', (r) => transformAccount(this.id, r));
  }

  fetchCustomers(): Promise<FetchResult<ProviderParty>> {
    return this.fetchEntity('customers', (r) => transformParty(this.id, r, 'customers'));
  }

  fetchVendors(): Promise<FetchResult<ProviderParty>> {
    return this.fetchEntity('vendors', (r) => transformParty(this.id, r, 'vendors'));
  }

  fetchOpenAR(): Promise<FetchResult<ProviderOpenItem>> {
    return this.fetchEntity('open_ar', (r) => transformOpenItem(this.id, r, 'openAR'));
  }

  fetchOpenAP(): Promise<FetchResult<ProviderOpenItem>> {
    return this.fetchEntity('open_ap', (r) => transformOpenItem(this.id, r, 'openAP'));
  }
}
