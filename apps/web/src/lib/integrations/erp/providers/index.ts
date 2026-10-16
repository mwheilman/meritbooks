/**
 * Direct-API migration providers — public surface + factory.
 *
 * `getMigrationProvider(id, { mock })` returns the right ConnectorProvider:
 *   • mock:true  → MockConnectorProvider (fixtures; exercisable now).
 *   • otherwise  → RealConnectorProvider (credential-gated; degrades safe).
 *
 * NOTE: this factory is org-blind, so its real adapter is never live. Routes that
 * pull a tenant's books should use `resolveMigrationProvider` (../resolve-provider.ts),
 * which returns the live QBO adapter for a connected org and refuses sample data in
 * production.
 */

import { MockConnectorProvider } from './mock';
import { RealConnectorProvider } from './real';
import type { ConnectorProvider, MigrationProviderId } from './types';

export * from './types';
export * from './registry';
export {
  getMappingProfile,
  transformTrialBalanceRow,
  transformAccount,
  transformParty,
  transformOpenItem,
  normalizeAccountType,
} from './mapping';
export type { ProviderMappingProfile, FieldMapEntry } from './mapping';
export {
  trialBalanceToConversionInput,
  conversionMapping,
  conversionMappingIsValid,
  centsToDecimalString,
  CONVERSION_HEADERS,
  type ConversionInput,
} from './conversion-adapter';
export { MockConnectorProvider } from './mock';
export { RealConnectorProvider } from './real';
export type { LiveRawSource, RealProviderOptions } from './real';
export {
  selectMigrationProvider,
  isProductionRuntime,
  type ProviderSelection,
  type ProviderSelectionInput,
} from './selection';

export interface GetProviderOptions {
  /** Use the fixture-backed mock adapter instead of the credential-gated real one. */
  mock?: boolean;
  /** Override env (tests). */
  env?: NodeJS.ProcessEnv;
}

export function getMigrationProvider(
  id: MigrationProviderId,
  opts: GetProviderOptions = {},
): ConnectorProvider {
  if (opts.mock) return new MockConnectorProvider(id);
  return new RealConnectorProvider(id, opts.env ?? process.env);
}
