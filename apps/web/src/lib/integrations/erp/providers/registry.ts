/**
 * Registry of the direct-API MIGRATION providers.
 *
 * This is the descriptive layer the UI and the /providers API render: display name,
 * auth type, the entities we can import, and which of the broad connector-CATALOG
 * ids (catalog.ts) each corresponds to. It is intentionally separate from the catalog
 * (which lists every operational system a tenant might connect); this registry is only
 * the three accounting systems we can pull FROM via a first-party direct API.
 */

import { getMappingProfile } from './mapping';
import { MIGRATION_ENTITY_LABELS } from './types';
import type { MigrationEntity, MigrationProviderId } from './types';

export interface MigrationProviderDef {
  id: MigrationProviderId;
  name: string;
  /** The auth handshake the live connector uses. */
  authType: 'OAUTH2';
  /** The catalog connector id this maps to (for the Connect flow). */
  catalogId: string;
  /** Entities importable from this source. */
  entities: MigrationEntity[];
  /** The primary entity that feeds the balanced opening journal entry. */
  openingBalanceEntity: MigrationEntity;
  /** One-line description shown on the migration card. */
  description: string;
  /** True when a fixture exists so "Preview import" can run end-to-end now. */
  fixtureAvailable: boolean;
}

const ENTITIES: MigrationEntity[] = [
  'accounts',
  'customers',
  'vendors',
  'open_ar',
  'open_ap',
  'trial_balance',
];

export const MIGRATION_PROVIDERS: MigrationProviderDef[] = [
  {
    id: 'quickbooks',
    name: 'QuickBooks Online',
    authType: 'OAUTH2',
    catalogId: 'quickbooks',
    entities: ENTITIES,
    openingBalanceEntity: 'trial_balance',
    description: 'Migrate your prior books from QuickBooks Online into the MeritBooks general ledger.',
    fixtureAvailable: true,
  },
  {
    id: 'xero',
    name: 'Xero',
    authType: 'OAUTH2',
    catalogId: 'xero',
    entities: ENTITIES,
    openingBalanceEntity: 'trial_balance',
    description: 'Migrate your prior books from Xero into the MeritBooks general ledger.',
    fixtureAvailable: true,
  },
  {
    id: 'sage',
    name: 'Sage',
    authType: 'OAUTH2',
    catalogId: 'sage',
    entities: ENTITIES,
    openingBalanceEntity: 'trial_balance',
    description: 'Migrate your prior books from Sage (Accounting / 50) into the MeritBooks general ledger.',
    fixtureAvailable: true,
  },
];

export function getMigrationProviderDef(id: MigrationProviderId): MigrationProviderDef {
  return MIGRATION_PROVIDERS.find((p) => p.id === id)!;
}

/** Entity labels + the provider's declared source field names, for the UI/preview. */
export function describeProviderEntities(
  id: MigrationProviderId,
): { entity: MigrationEntity; label: string; sourceFields: string[] }[] {
  const profile = getMappingProfile(id);
  const byEntity: Record<MigrationEntity, { from: string }[]> = {
    accounts: profile.accounts,
    customers: profile.customers,
    vendors: profile.vendors,
    open_ar: profile.openAR,
    open_ap: profile.openAP,
    trial_balance: profile.trialBalance,
  };
  return ENTITIES.map((entity) => ({
    entity,
    label: MIGRATION_ENTITY_LABELS[entity],
    sourceFields: byEntity[entity].map((f) => f.from),
  }));
}
