/**
 * Credential-gated REAL migration adapters (QuickBooks Online / Xero / Sage).
 *
 * DEGRADE-SAFE by contract: every fetch resolves to a NotConnectedResult — it never
 * throws and never touches a network — in two cases:
 *   1. No OAuth credentials are configured for this provider (the state today).
 *   2. Credentials exist but the live HTTP client is not wired in this build.
 *
 * This is the deliberate seam. The mapping profiles and the whole downstream
 * conversion pipeline are ready; the only remaining work to make the real pull run is
 * (a) Mike adding the provider's OAuth credentials to the env, and (b) implementing
 * `liveFetch` to call the provider REST API and hand the raw records to the SAME
 * transforms the mock adapter already uses. Until then the mock/fixture path is the
 * exercisable one, and the real adapter honestly reports "not connected".
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
 * Live raw fetch — NOT YET WIRED. Returns null to signal "no live client", which the
 * adapter turns into a NotConnectedResult. When implemented it must return the
 * provider-native raw records for the entity (the same shape the fixtures use), which
 * are then passed through the shared transforms — no bypassing the mapping profiles.
 */
async function liveFetch(
  _creds: MigrationCredentials,
  _entity: MigrationEntity,
): Promise<RawRecord[] | null> {
  // Intentionally not implemented: we do not call a live provider in this build.
  return null;
}

export class RealConnectorProvider implements ConnectorProvider {
  readonly id: MigrationProviderId;
  private readonly creds: MigrationCredentials | null;

  constructor(id: MigrationProviderId, env: NodeJS.ProcessEnv = process.env) {
    this.id = id;
    this.creds = readMigrationCredentials(id, env);
  }

  listEntities(): MigrationEntity[] {
    return [...ALL_ENTITIES];
  }

  /** True when OAuth credentials are present for this provider. */
  hasCredentials(): boolean {
    return this.creds !== null;
  }

  private notConnected<T>(): FetchResult<T> {
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
    if (!this.creds) return this.notConnected<T>();
    const raw = await liveFetch(this.creds, entity);
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
