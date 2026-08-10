/**
 * Direct-API MIGRATION providers — shared types.
 *
 * These are the connectors a tenant MIGRATES OFF OF (QuickBooks Online, Xero, Sage).
 * MeritBooks OWNS the general ledger; per canon §1 these ERPs are ONE-TIME import
 * sources, not a live automation layer. The direct-API path pulls the prior books
 * once and feeds the SAME historical-conversion pipeline the CSV path uses (balanced
 * opening journal entry + human tie-out gate) — it never posts on its own.
 *
 * Division of labor (mirrors the CSV path):
 *   • The adapter PULLS provider-native records (credential-gated; degrade-safe when
 *     no OAuth credentials are configured — nothing throws, nothing calls a network).
 *   • A deterministic FIELD-MAPPING PROFILE (mapping.ts) transforms each provider's
 *     fixed schema → the MeritBooks normalized shape. Deterministic because a known
 *     provider has a fixed schema — no AI is required or used here.
 *   • conversion-adapter.ts turns the normalized trial balance into the exact
 *     `{ mapping, rows }` input the existing /api/onboarding/conversion route accepts,
 *     so everything downstream (AI/heuristic account mapping, opening-TB assembly,
 *     balance check, preview, tie-out, posting) is the untouched existing pipeline.
 *
 * NO SECRETS live in this layer's persisted state. Credentials are read from the
 * platform env at call time (readMigrationCredentials) and never stored on a row.
 */

/** The three direct-API migration source systems. */
export type MigrationProviderId = 'quickbooks' | 'xero' | 'sage';

export const MIGRATION_PROVIDER_IDS: readonly MigrationProviderId[] = [
  'quickbooks',
  'xero',
  'sage',
] as const;

export function isMigrationProviderId(v: string): v is MigrationProviderId {
  return (MIGRATION_PROVIDER_IDS as readonly string[]).includes(v);
}

/** The accounting-relevant entities a migration source can bring over. */
export type MigrationEntity =
  | 'accounts' // chart of accounts
  | 'customers' // AR master data
  | 'vendors' // AP master data
  | 'open_ar' // outstanding customer invoices
  | 'open_ap' // outstanding vendor bills
  | 'trial_balance'; // opening balances (feeds the balanced opening JE)

export const MIGRATION_ENTITY_LABELS: Record<MigrationEntity, string> = {
  accounts: 'Chart of accounts',
  customers: 'Customers',
  vendors: 'Vendors',
  open_ar: 'Open AR',
  open_ap: 'Open AP',
  trial_balance: 'Trial balance / opening balances',
};

// ─────────────────────────────────────────────────────────────────────────────
// Normalized records — the MeritBooks-shaped output of every provider profile.
// All money is integer CENTS (bigint domain), per the money invariant.
// ─────────────────────────────────────────────────────────────────────────────

/** Normalized account type (a subset of MeritBooks' account_type_enum). */
export type NormalizedAccountType =
  | 'ASSET'
  | 'LIABILITY'
  | 'EQUITY'
  | 'REVENUE'
  | 'COGS'
  | 'OPEX'
  | 'OTHER';

export interface ProviderAccount {
  /** Account number / code as it exists in the source system. */
  code: string;
  name: string;
  /** Normalized account type, when the source classifies it; null otherwise. */
  type: NormalizedAccountType | null;
}

export interface ProviderParty {
  /** The source system's stable id for the customer/vendor. */
  externalId: string;
  name: string;
  email: string | null;
  phone: string | null;
}

export interface ProviderOpenItem {
  /** Customer (AR) or vendor (AP) display name — matched by name on import. */
  partyName: string;
  docNumber: string;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  dueDate: string;
  totalCents: number;
  /** Remaining open balance in cents (what still shows on the aging). */
  balanceCents: number;
}

/** One line of the source trial balance — the opening-balances feed. Cents. */
export interface ProviderTrialBalanceRow {
  accountCode: string;
  accountName: string | null;
  debitCents: number;
  creditCents: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch results — always degrade-safe (a fetch NEVER throws on missing creds).
// ─────────────────────────────────────────────────────────────────────────────

/** The provider is not usable: no OAuth credentials, or live sync not enabled. */
export interface NotConnectedResult {
  connected: false;
  /** Human-readable, safe to surface in the UI. */
  reason: string;
}

/** A successful pull. `source` distinguishes real API data from fixtures. */
export interface ConnectedResult<T> {
  connected: true;
  source: 'live' | 'mock';
  entity: MigrationEntity;
  records: T[];
}

export type FetchResult<T> = ConnectedResult<T> | NotConnectedResult;

/**
 * The pull interface every migration adapter implements. Each method is
 * degrade-safe: without credentials (or with credentials but no live client wired
 * yet) it resolves to a NotConnectedResult — it does not throw and does not call a
 * network. The MOCK adapter returns fixtures so the whole path is exercisable now.
 */
export interface ConnectorProvider {
  readonly id: MigrationProviderId;
  /** Which entities this provider can bring over. */
  listEntities(): MigrationEntity[];
  fetchAccounts(): Promise<FetchResult<ProviderAccount>>;
  fetchCustomers(): Promise<FetchResult<ProviderParty>>;
  fetchVendors(): Promise<FetchResult<ProviderParty>>;
  fetchOpenAR(): Promise<FetchResult<ProviderOpenItem>>;
  fetchOpenAP(): Promise<FetchResult<ProviderOpenItem>>;
  fetchTrialBalance(): Promise<FetchResult<ProviderTrialBalanceRow>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Credentials — read from env at call time; NEVER persisted on a connection row.
// ─────────────────────────────────────────────────────────────────────────────

export interface MigrationCredentials {
  provider: MigrationProviderId;
  clientId: string;
  clientSecret: string;
  accessToken: string;
  /** QBO realmId / Xero tenantId; not all providers use it. */
  tenantRef: string | null;
}

/**
 * Read a provider's OAuth credentials from the platform env. Returns null when the
 * essential values are absent — the signal to DEGRADE SAFE ("not connected — add
 * credentials"). None are configured today, so this returns null for all three; the
 * seam is here so that when Mike adds them later the real adapter can pull.
 */
export function readMigrationCredentials(
  id: MigrationProviderId,
  env: NodeJS.ProcessEnv = process.env,
): MigrationCredentials | null {
  const prefix = id === 'quickbooks' ? 'QUICKBOOKS' : id === 'xero' ? 'XERO' : 'SAGE';
  const clientId = env[`${prefix}_CLIENT_ID`] ?? '';
  const clientSecret = env[`${prefix}_CLIENT_SECRET`] ?? '';
  const accessToken = env[`${prefix}_ACCESS_TOKEN`] ?? '';
  // QBO/Xero require an org scope ref (realmId / tenantId); Sage does not.
  const tenantRef =
    env[`${prefix}_REALM_ID`] ?? env[`${prefix}_TENANT_ID`] ?? env[`${prefix}_COMPANY_ID`] ?? null;

  const needsTenantRef = id === 'quickbooks' || id === 'xero';
  const hasEssentials =
    clientId.length > 0 &&
    clientSecret.length > 0 &&
    accessToken.length > 0 &&
    (!needsTenantRef || (tenantRef !== null && tenantRef.length > 0));

  if (!hasEssentials) return null;
  return { provider: id, clientId, clientSecret, accessToken, tenantRef };
}
