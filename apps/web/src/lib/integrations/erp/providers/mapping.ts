/**
 * Deterministic FIELD-MAPPING PROFILES for the direct-API migration providers.
 *
 * A known provider (QuickBooks Online / Xero / Sage) has a FIXED schema, so mapping
 * its records into the MeritBooks normalized shape is deterministic — no AI needed
 * (and AI is a convenience elsewhere, never the accounting authority; canon §3).
 *
 * Each profile documents, per entity, how the provider's native field names line up
 * with our normalized fields. The `transform*` functions are the executable form of
 * those profiles: they read the provider-native raw record and emit a typed,
 * cents-denominated normalized record. Keeping the profile as DATA (inspectable,
 * testable) and the transform beside it means the unit tests can assert both the
 * declared mapping and the actual conversion.
 *
 * Money: providers report decimal DOLLARS (QBO/Sage as strings, Xero as numbers).
 * We convert to integer CENTS here via dollarsToCents so the rest of the system
 * stays in the bigint-cents domain.
 */

import { dollarsToCents } from '@meritbooks/shared';
import type {
  MigrationProviderId,
  NormalizedAccountType,
  ProviderAccount,
  ProviderOpenItem,
  ProviderParty,
  ProviderTrialBalanceRow,
} from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Profile shape (the declared, inspectable mapping)
// ─────────────────────────────────────────────────────────────────────────────

export type NormalizedField =
  | 'accountCode'
  | 'accountName'
  | 'accountType'
  | 'debit'
  | 'credit'
  | 'externalId'
  | 'name'
  | 'email'
  | 'phone'
  | 'partyName'
  | 'docNumber'
  | 'date'
  | 'dueDate'
  | 'total'
  | 'balance';

export interface FieldMapEntry {
  /** The field/column name exactly as the provider's API/report returns it. */
  from: string;
  /** The MeritBooks normalized field it maps to. */
  to: NormalizedField;
  /** How the raw value is interpreted. */
  kind: 'text' | 'money' | 'date' | 'account_type';
}

export interface ProviderMappingProfile {
  provider: MigrationProviderId;
  displayName: string;
  trialBalance: FieldMapEntry[];
  accounts: FieldMapEntry[];
  customers: FieldMapEntry[];
  vendors: FieldMapEntry[];
  openAR: FieldMapEntry[];
  openAP: FieldMapEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────
// The three profiles. Field names reflect each provider's real report/API schema.
// ─────────────────────────────────────────────────────────────────────────────

const QBO_PROFILE: ProviderMappingProfile = {
  provider: 'quickbooks',
  displayName: 'QuickBooks Online',
  // QBO TrialBalance report columns / Account entity fields.
  trialBalance: [
    { from: 'AcctNum', to: 'accountCode', kind: 'text' },
    { from: 'Name', to: 'accountName', kind: 'text' },
    { from: 'Debit', to: 'debit', kind: 'money' },
    { from: 'Credit', to: 'credit', kind: 'money' },
  ],
  accounts: [
    { from: 'AcctNum', to: 'accountCode', kind: 'text' },
    { from: 'Name', to: 'accountName', kind: 'text' },
    { from: 'AccountType', to: 'accountType', kind: 'account_type' },
  ],
  customers: [
    { from: 'Id', to: 'externalId', kind: 'text' },
    { from: 'DisplayName', to: 'name', kind: 'text' },
    { from: 'PrimaryEmailAddr', to: 'email', kind: 'text' },
    { from: 'PrimaryPhone', to: 'phone', kind: 'text' },
  ],
  vendors: [
    { from: 'Id', to: 'externalId', kind: 'text' },
    { from: 'DisplayName', to: 'name', kind: 'text' },
    { from: 'PrimaryEmailAddr', to: 'email', kind: 'text' },
    { from: 'PrimaryPhone', to: 'phone', kind: 'text' },
  ],
  openAR: [
    { from: 'CustomerName', to: 'partyName', kind: 'text' },
    { from: 'DocNumber', to: 'docNumber', kind: 'text' },
    { from: 'TxnDate', to: 'date', kind: 'date' },
    { from: 'DueDate', to: 'dueDate', kind: 'date' },
    { from: 'TotalAmt', to: 'total', kind: 'money' },
    { from: 'Balance', to: 'balance', kind: 'money' },
  ],
  openAP: [
    { from: 'VendorName', to: 'partyName', kind: 'text' },
    { from: 'DocNumber', to: 'docNumber', kind: 'text' },
    { from: 'TxnDate', to: 'date', kind: 'date' },
    { from: 'DueDate', to: 'dueDate', kind: 'date' },
    { from: 'TotalAmt', to: 'total', kind: 'money' },
    { from: 'Balance', to: 'balance', kind: 'money' },
  ],
};

const XERO_PROFILE: ProviderMappingProfile = {
  provider: 'xero',
  displayName: 'Xero',
  // Xero TrialBalance report rows / Account API fields.
  trialBalance: [
    { from: 'AccountCode', to: 'accountCode', kind: 'text' },
    { from: 'AccountName', to: 'accountName', kind: 'text' },
    { from: 'Debit', to: 'debit', kind: 'money' },
    { from: 'Credit', to: 'credit', kind: 'money' },
  ],
  accounts: [
    { from: 'Code', to: 'accountCode', kind: 'text' },
    { from: 'Name', to: 'accountName', kind: 'text' },
    { from: 'Class', to: 'accountType', kind: 'account_type' },
  ],
  customers: [
    { from: 'ContactID', to: 'externalId', kind: 'text' },
    { from: 'Name', to: 'name', kind: 'text' },
    { from: 'EmailAddress', to: 'email', kind: 'text' },
    { from: 'Phone', to: 'phone', kind: 'text' },
  ],
  vendors: [
    { from: 'ContactID', to: 'externalId', kind: 'text' },
    { from: 'Name', to: 'name', kind: 'text' },
    { from: 'EmailAddress', to: 'email', kind: 'text' },
    { from: 'Phone', to: 'phone', kind: 'text' },
  ],
  openAR: [
    { from: 'Contact', to: 'partyName', kind: 'text' },
    { from: 'InvoiceNumber', to: 'docNumber', kind: 'text' },
    { from: 'Date', to: 'date', kind: 'date' },
    { from: 'DueDate', to: 'dueDate', kind: 'date' },
    { from: 'Total', to: 'total', kind: 'money' },
    { from: 'AmountDue', to: 'balance', kind: 'money' },
  ],
  openAP: [
    { from: 'Contact', to: 'partyName', kind: 'text' },
    { from: 'InvoiceNumber', to: 'docNumber', kind: 'text' },
    { from: 'Date', to: 'date', kind: 'date' },
    { from: 'DueDate', to: 'dueDate', kind: 'date' },
    { from: 'Total', to: 'total', kind: 'money' },
    { from: 'AmountDue', to: 'balance', kind: 'money' },
  ],
};

const SAGE_PROFILE: ProviderMappingProfile = {
  provider: 'sage',
  displayName: 'Sage',
  // Sage Accounting ledger-account / trial-balance fields (nominal codes).
  trialBalance: [
    { from: 'nominal_code', to: 'accountCode', kind: 'text' },
    { from: 'name', to: 'accountName', kind: 'text' },
    { from: 'debit', to: 'debit', kind: 'money' },
    { from: 'credit', to: 'credit', kind: 'money' },
  ],
  accounts: [
    { from: 'nominal_code', to: 'accountCode', kind: 'text' },
    { from: 'name', to: 'accountName', kind: 'text' },
    { from: 'ledger_account_type', to: 'accountType', kind: 'account_type' },
  ],
  customers: [
    { from: 'id', to: 'externalId', kind: 'text' },
    { from: 'name', to: 'name', kind: 'text' },
    { from: 'email', to: 'email', kind: 'text' },
    { from: 'telephone', to: 'phone', kind: 'text' },
  ],
  vendors: [
    { from: 'id', to: 'externalId', kind: 'text' },
    { from: 'name', to: 'name', kind: 'text' },
    { from: 'email', to: 'email', kind: 'text' },
    { from: 'telephone', to: 'phone', kind: 'text' },
  ],
  openAR: [
    { from: 'contact_name', to: 'partyName', kind: 'text' },
    { from: 'reference', to: 'docNumber', kind: 'text' },
    { from: 'date', to: 'date', kind: 'date' },
    { from: 'due_date', to: 'dueDate', kind: 'date' },
    { from: 'total_amount', to: 'total', kind: 'money' },
    { from: 'outstanding_amount', to: 'balance', kind: 'money' },
  ],
  openAP: [
    { from: 'contact_name', to: 'partyName', kind: 'text' },
    { from: 'reference', to: 'docNumber', kind: 'text' },
    { from: 'date', to: 'date', kind: 'date' },
    { from: 'due_date', to: 'dueDate', kind: 'date' },
    { from: 'total_amount', to: 'total', kind: 'money' },
    { from: 'outstanding_amount', to: 'balance', kind: 'money' },
  ],
};

const PROFILES: Record<MigrationProviderId, ProviderMappingProfile> = {
  quickbooks: QBO_PROFILE,
  xero: XERO_PROFILE,
  sage: SAGE_PROFILE,
};

export function getMappingProfile(id: MigrationProviderId): ProviderMappingProfile {
  return PROFILES[id];
}

// ─────────────────────────────────────────────────────────────────────────────
// Value coercion helpers (provider-native → normalized)
// ─────────────────────────────────────────────────────────────────────────────

/** A provider-native raw record: keys are the provider's field names. */
export type RawRecord = Record<string, unknown>;

function pick(raw: RawRecord, profile: FieldMapEntry[], to: NormalizedField): unknown {
  const entry = profile.find((e) => e.to === to);
  if (!entry) return undefined;
  return raw[entry.from];
}

/** Text → trimmed string or null. */
function asText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

/** Money → integer cents. Accepts strings ("1,250.00") or numbers (1250). */
function asCents(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return dollarsToCents(v);
  return dollarsToCents(String(v));
}

/**
 * Normalize a provider's account-type value into the MeritBooks account_type_enum
 * subset. Deterministic per provider; unknown values fall through to OTHER.
 */
export function normalizeAccountType(
  provider: MigrationProviderId,
  raw: unknown,
): NormalizedAccountType | null {
  const v = asText(raw);
  if (!v) return null;
  const key = v.toUpperCase();

  if (provider === 'quickbooks') {
    // QBO AccountType values.
    if (['BANK', 'ACCOUNTS RECEIVABLE', 'OTHER CURRENT ASSET', 'FIXED ASSET', 'OTHER ASSET'].includes(key)) return 'ASSET';
    if (['ACCOUNTS PAYABLE', 'CREDIT CARD', 'OTHER CURRENT LIABILITY', 'LONG TERM LIABILITY'].includes(key)) return 'LIABILITY';
    if (key === 'EQUITY') return 'EQUITY';
    if (key === 'INCOME' || key === 'OTHER INCOME') return 'REVENUE';
    if (key === 'COST OF GOODS SOLD') return 'COGS';
    if (key === 'EXPENSE' || key === 'OTHER EXPENSE') return 'OPEX';
    return 'OTHER';
  }

  if (provider === 'xero') {
    // Xero account Class values.
    if (key === 'ASSET') return 'ASSET';
    if (key === 'LIABILITY') return 'LIABILITY';
    if (key === 'EQUITY') return 'EQUITY';
    if (key === 'REVENUE') return 'REVENUE';
    if (key === 'EXPENSE') return 'OPEX';
    return 'OTHER';
  }

  // Sage ledger_account_type values.
  if (key === 'ASSET') return 'ASSET';
  if (key === 'LIABILITY') return 'LIABILITY';
  if (key === 'EQUITY') return 'EQUITY';
  if (key === 'INCOME' || key === 'REVENUE' || key === 'SALES') return 'REVENUE';
  if (key === 'DIRECT_EXPENSE' || key === 'COST_OF_SALES') return 'COGS';
  if (key === 'EXPENSE' || key === 'OVERHEAD' || key === 'OVERHEADS') return 'OPEX';
  return 'OTHER';
}

// ─────────────────────────────────────────────────────────────────────────────
// Executable transforms (raw provider record → normalized record)
// ─────────────────────────────────────────────────────────────────────────────

export function transformTrialBalanceRow(
  id: MigrationProviderId,
  raw: RawRecord,
): ProviderTrialBalanceRow {
  const p = getMappingProfile(id).trialBalance;
  return {
    accountCode: asText(pick(raw, p, 'accountCode')) ?? '',
    accountName: asText(pick(raw, p, 'accountName')),
    debitCents: asCents(pick(raw, p, 'debit')),
    creditCents: asCents(pick(raw, p, 'credit')),
  };
}

export function transformAccount(id: MigrationProviderId, raw: RawRecord): ProviderAccount {
  const p = getMappingProfile(id).accounts;
  return {
    code: asText(pick(raw, p, 'accountCode')) ?? '',
    name: asText(pick(raw, p, 'accountName')) ?? '',
    type: normalizeAccountType(id, pick(raw, p, 'accountType')),
  };
}

export function transformParty(
  id: MigrationProviderId,
  raw: RawRecord,
  which: 'customers' | 'vendors',
): ProviderParty {
  const p = getMappingProfile(id)[which];
  return {
    externalId: asText(pick(raw, p, 'externalId')) ?? '',
    name: asText(pick(raw, p, 'name')) ?? '',
    email: asText(pick(raw, p, 'email')),
    phone: asText(pick(raw, p, 'phone')),
  };
}

export function transformOpenItem(
  id: MigrationProviderId,
  raw: RawRecord,
  which: 'openAR' | 'openAP',
): ProviderOpenItem {
  const p = getMappingProfile(id)[which];
  return {
    partyName: asText(pick(raw, p, 'partyName')) ?? '',
    docNumber: asText(pick(raw, p, 'docNumber')) ?? '',
    date: asText(pick(raw, p, 'date')) ?? '',
    dueDate: asText(pick(raw, p, 'dueDate')) ?? '',
    totalCents: asCents(pick(raw, p, 'total')),
    balanceCents: asCents(pick(raw, p, 'balance')),
  };
}
