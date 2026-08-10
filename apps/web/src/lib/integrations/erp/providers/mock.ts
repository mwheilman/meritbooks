/**
 * MOCK migration adapter — fixture-driven, so the direct-API → conversion path is
 * fully exercisable before any OAuth credentials exist. It runs the SAME mapping
 * profiles the real adapters will, against the provider-native fixtures, and returns
 * normalized records tagged `source: 'mock'`.
 */

import {
  transformAccount,
  transformOpenItem,
  transformParty,
  transformTrialBalanceRow,
} from './mapping';
import { getProviderFixture } from './fixtures';
import type {
  ConnectorProvider,
  FetchResult,
  MigrationEntity,
  MigrationProviderId,
  ProviderAccount,
  ProviderOpenItem,
  ProviderParty,
  ProviderTrialBalanceRow,
} from './types';

const ALL_ENTITIES: MigrationEntity[] = [
  'accounts',
  'customers',
  'vendors',
  'open_ar',
  'open_ap',
  'trial_balance',
];

export class MockConnectorProvider implements ConnectorProvider {
  readonly id: MigrationProviderId;

  constructor(id: MigrationProviderId) {
    this.id = id;
  }

  listEntities(): MigrationEntity[] {
    return [...ALL_ENTITIES];
  }

  private ok<T>(entity: MigrationEntity, records: T[]): FetchResult<T> {
    return { connected: true, source: 'mock', entity, records };
  }

  async fetchTrialBalance(): Promise<FetchResult<ProviderTrialBalanceRow>> {
    const raw = getProviderFixture(this.id).trialBalance;
    return this.ok('trial_balance', raw.map((r) => transformTrialBalanceRow(this.id, r)));
  }

  async fetchAccounts(): Promise<FetchResult<ProviderAccount>> {
    const raw = getProviderFixture(this.id).accounts;
    return this.ok('accounts', raw.map((r) => transformAccount(this.id, r)));
  }

  async fetchCustomers(): Promise<FetchResult<ProviderParty>> {
    const raw = getProviderFixture(this.id).customers;
    return this.ok('customers', raw.map((r) => transformParty(this.id, r, 'customers')));
  }

  async fetchVendors(): Promise<FetchResult<ProviderParty>> {
    const raw = getProviderFixture(this.id).vendors;
    return this.ok('vendors', raw.map((r) => transformParty(this.id, r, 'vendors')));
  }

  async fetchOpenAR(): Promise<FetchResult<ProviderOpenItem>> {
    const raw = getProviderFixture(this.id).openAR;
    return this.ok('open_ar', raw.map((r) => transformOpenItem(this.id, r, 'openAR')));
  }

  async fetchOpenAP(): Promise<FetchResult<ProviderOpenItem>> {
    const raw = getProviderFixture(this.id).openAP;
    return this.ok('open_ap', raw.map((r) => transformOpenItem(this.id, r, 'openAP')));
  }
}
