/**
 * Onboarding v2 — client migration (docs/ia/08-ONBOARDING-V2-SPEC.md, FPB-onboarding §9).
 *
 * The shared contract for every piece of the migration slice: the stage machine, the
 * source catalog, staged records, the mapping cascade, the 24 preflight checks and the
 * tie-out certificate. Pure types — no I/O. Money is ALWAYS integer cents (bigint in the
 * DB, a JS number here — safe below 2^53). Dates are ISO `YYYY-MM-DD`.
 *
 * Storage values (stage `plan`, check `PF-01`, …) never appear in the UI on their own:
 * every screen uses the plain-English labels from stages.ts / the check's `name`.
 */

// ── Stages (DB values; UI labels live in stages.ts) ─────────────────────────────

export const STAGES = ['plan', 'connect', 'preflight', 'map', 'tie_out', 'shadow_close', 'certified', 'live'] as const;
export type Stage = (typeof STAGES)[number];
export type ProjectStage = Stage | 'paused' | 'abandoned';

export type HistoryDepth = 'opening_only' | 'monthly' | 'monthly_plus_detail';
export type ShadowMode = 'parallel' | 'clean_switch' | 'none';
export type ChartStrategy = 'keep_source_chart' | 'tenant_standard';

// ── Sources ─────────────────────────────────────────────────────────────────────

export type SourceRole =
  | 'ledger_source'
  | 'field_system'
  | 'bank'
  | 'card_spend'
  | 'payroll'
  | 'crm'
  | 'docs';

/** How a system connects TODAY (honest — the catalog never claims more than this). */
export type SourceTier = 'native_api' | 'recipe' | 'generic_file';

export type SourceStatus = 'planned' | 'connected' | 'pulled' | 'stale' | 'error' | 'archived';

/** What a staged record is. Mirrors the staged_records.entity CHECK in migration 193. */
export const STAGED_ENTITIES = [
  'account',
  'tb_line',
  'customer',
  'vendor',
  'item',
  'dimension',
  'job',
  'open_invoice',
  'open_bill',
  'bank_balance',
  'evidence',
] as const;
export type StagedEntity = (typeof STAGED_ENTITIES)[number];

/** MeritBooks account types (account_type_enum). */
export type MeritAccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'COGS' | 'OPEX' | 'OTHER';

// ── Staged payloads (normalized, money in cents) ───────────────────────────────

export interface StagedAccount {
  number: string;
  name: string;
  /** Our best reading of the type (from the source type, or the number range). */
  type: MeritAccountType | null;
  /** Source system's own type label ("Accounts Receivable", "Bank" …). */
  sourceType: string | null;
  /** Source system's detail/sub type ("UndepositedFunds", "AccountsReceivable" …). */
  detailType: string | null;
  active: boolean;
  /** Debit-positive balance at cutover (0 when unknown). */
  balanceCents: number;
}

export interface StagedTbLine {
  number: string;
  name: string;
  debitCents: number;
  creditCents: number;
  type?: MeritAccountType | null;
  sourceType?: string | null;
  detailType?: string | null;
  active?: boolean;
}

export interface StagedParty {
  name: string;
  email?: string | null;
  phone?: string | null;
  /**
   * TRANSIENT — the tax id as parsed from the file (recognize.ts). Never persisted: writeRun
   * (server/staging.ts) replaces it with `taxIdHash` + `taxIdLast4` before any row is written
   * (security review H2). Staged rows read back from the database never carry it.
   */
  taxId?: string | null;
  /** Org-scoped keyed fingerprint of the tax id (lib/vendors/tin-fingerprint.ts); null = none / no key. */
  taxIdHash?: string | null;
  /** Last four digits of the tax id (display / "has a TIN" checks). */
  taxIdLast4?: string | null;
  address?: string | null;
  /** Vendor flagged as a 1099 vendor in the source. */
  is1099?: boolean | null;
  /** Payments this calendar year (vendors) — for the 1099 check. */
  ytdPaidCents?: number | null;
  active?: boolean;
}

export interface StagedItem {
  name: string;
  sku?: string | null;
  kind?: string | null;
  incomeAccount?: string | null;
}

export interface StagedDimension {
  name: string;
  /** Where it came from: a QuickBooks class / location, a field-system business unit, a department. */
  kind: 'class' | 'location' | 'department' | 'business_unit';
  txnCount?: number | null;
}

export interface StagedJob {
  number: string | null;
  name: string;
  customer: string | null;
  status: string | null;
  contractCents?: number | null;
  billedCents?: number | null;
  costCents?: number | null;
  /** Billed to date − earned to date, when the export carries it. */
  unbilledCents?: number | null;
  billingsInExcessCents?: number | null;
}

export interface StagedOpenItem {
  docNumber: string;
  party: string;
  date: string | null;
  dueDate: string | null;
  totalCents: number;
  balanceCents: number;
  /** Payment / credit not applied to an invoice (negative open items). */
  unapplied?: boolean;
}

export interface StagedBankBalance {
  label: string;
  /** The GL account it sits in, when known (source number). */
  glAccountNumber: string | null;
  statementBalanceCents: number;
  statementDate: string | null;
  lastReconciledDate: string | null;
  unclearedCount?: number | null;
  unclearedTotalCents?: number | null;
  oldestUnclearedDate?: string | null;
}

export type EvidenceKind = 'loan' | 'sales_tax' | 'payroll_liability' | 'depreciation' | 'currency' | 'books_closed';

export interface StagedEvidence {
  kind: EvidenceKind;
  label: string;
  amountCents: number | null;
  asOf: string | null;
  glAccountNumber?: string | null;
  /** Free-form extra fields (e.g. currency code, last depreciation date). */
  note?: string | null;
}

export type StagedPayload =
  | { entity: 'account'; data: StagedAccount }
  | { entity: 'tb_line'; data: StagedTbLine }
  | { entity: 'customer'; data: StagedParty }
  | { entity: 'vendor'; data: StagedParty }
  | { entity: 'item'; data: StagedItem }
  | { entity: 'dimension'; data: StagedDimension }
  | { entity: 'job'; data: StagedJob }
  | { entity: 'open_invoice'; data: StagedOpenItem }
  | { entity: 'open_bill'; data: StagedOpenItem }
  | { entity: 'bank_balance'; data: StagedBankBalance }
  | { entity: 'evidence'; data: StagedEvidence };

// ── Preflight (the 24 checks, §8) ──────────────────────────────────────────────

export const PREFLIGHT_CHECK_IDS = [
  'PF-01', 'PF-02', 'PF-03', 'PF-04', 'PF-05', 'PF-06', 'PF-07', 'PF-08',
  'PF-09', 'PF-10', 'PF-11', 'PF-12', 'PF-13', 'PF-14', 'PF-15', 'PF-16',
  'PF-17', 'PF-18', 'PF-19', 'PF-20', 'PF-21', 'PF-22', 'PF-23', 'PF-24',
] as const;
export type PreflightCheckId = (typeof PREFLIGHT_CHECK_IDS)[number];

/** blocker stops "Prove balances"; warning needs a decision; info feeds matching. */
export type PreflightSeverity = 'blocker' | 'warning' | 'info' | 'passed' | 'not_applicable';

export type PreflightDisposition =
  | 'open'
  | 'fixed_in_source'
  | 'carry_as_reconciling_item'
  | 'accepted_with_note'
  | 'not_applicable';

export interface PfAccount {
  number: string;
  name: string;
  type: MeritAccountType | null;
  sourceType: string | null;
  detailType: string | null;
  active: boolean;
  /** Debit-positive balance at cutover. */
  balanceCents: number;
}

export interface PfParty {
  name: string;
  email: string | null;
  phone: string | null;
  /** Keyed fingerprint of the tax id (never the id itself — H2); equal fingerprints = same id. */
  taxIdHash: string | null;
  /** A tax id is on file (fingerprint or last four). */
  hasTaxId: boolean;
  is1099: boolean;
  ytdPaidCents: number;
}

export interface PfOpenItem {
  docNumber: string;
  party: string;
  balanceCents: number;
  date: string | null;
}

export interface PfBank {
  label: string;
  glAccountNumber: string | null;
  statementBalanceCents: number;
  lastReconciledDate: string | null;
  unclearedTotalCents: number;
  oldestUnclearedDate: string | null;
}

export interface PfJob {
  number: string | null;
  name: string;
  costCents: number;
  unbilledCents: number;
  billingsInExcessCents: number;
}

export interface PfEvidence {
  kind: EvidenceKind;
  label: string;
  amountCents: number | null;
  asOf: string | null;
  glAccountNumber: string | null;
  note: string | null;
}

/** The other side of an intercompany balance, from another client in the same firm. */
export interface PfIntercompany {
  /** This client's due-from / due-to account. */
  accountNumber: string;
  accountName: string;
  /** Debit-positive balance on this client's books. */
  thisSideCents: number;
  /** The counterparty client (as named in the account). */
  counterpartyName: string;
  /** Debit-positive balance of the mirror account on the counterparty's books; null = not staged yet. */
  otherSideCents: number | null;
}

/**
 * Everything the 24 checks read. `null` for a collection = "not provided yet" (the check
 * reports not_applicable with what to drop to run it); an empty array = provided, none.
 */
export interface PreflightInput {
  /** Cutover date (YYYY-MM-DD). */
  asOf: string | null;
  /** Source chart with balances at cutover. Empty = no chart / TB yet. */
  accounts: PfAccount[];
  /** A trial balance at cutover was staged (accounts carry real balances). */
  tbAvailable: boolean;
  openInvoices: PfOpenItem[] | null;
  openBills: PfOpenItem[] | null;
  customers: PfParty[] | null;
  vendors: PfParty[] | null;
  bank: PfBank[] | null;
  jobs: PfJob[] | null;
  evidence: PfEvidence[];
  /** Open invoices from a FIELD system (ServiceTitan, simPRO …), to tie to the ledger's AR. */
  fieldOpenInvoices: PfOpenItem[] | null;
  intercompany: PfIntercompany[];
  /** Retained earnings at the prior fiscal year end + prior-year net income, when known. */
  priorYear: { retainedEarningsCents: number; netIncomeCents: number } | null;
  /** The source's "books closed through" date, when known. */
  booksClosedThrough: string | null;
  /** Source data changed after it was pulled (fingerprint / re-upload differs). */
  sourceChangedSincePull: boolean;
}

export interface PreflightResult {
  checkId: PreflightCheckId;
  severity: PreflightSeverity;
  /** Plain-English name of the check ("Receivables match the A/R account"). */
  name: string;
  /** Plain-English headline of the result. */
  title: string;
  /** Plain-English explanation, in dollars (never cents). */
  message: string;
  /** Suggested fix, plain English. */
  fix: string;
  /** Absolute dollar impact, integer cents (0 when none). */
  amountCents: number;
  accounts: string[];
  /** A few example records + the total count behind the finding. */
  records: { sample: string[]; count: number };
}

// ── Mapping cascade (§7.1) ──────────────────────────────────────────────────────

export type MappingProposalSource = 'rule' | 'crosswalk' | 'number' | 'name' | 'ai' | 'human' | 'unmapped';
export type MappingBand = 'ready' | 'check' | 'decide';
export type TypeGuard = 'ok' | 'warn' | 'block';

export interface MappingTarget {
  id: string;
  number: string;
  name: string;
  type: MeritAccountType | null;
}

export interface MappingSourceAccount {
  key: string;
  number: string | null;
  name: string;
  type: MeritAccountType | null;
  sourceType: string | null;
  detailType: string | null;
  /** Debit-positive balance at cutover. */
  balanceCents: number;
}

/** A firm mapping-memory rule (mapping_rules) as the cascade sees it. */
export interface MappingRuleRef {
  id: string;
  matchKind: 'exact_number' | 'normalized_name';
  matchValue: string;
  targetAccountId: string;
  /** Clients that approved this answer. */
  evidenceCount: number;
  /** Other clients mapped the same key differently. */
  conflict: boolean;
}

export interface MappingProposal {
  key: string;
  targetAccountId: string | null;
  source: MappingProposalSource;
  ruleId: string | null;
  /** 0..1 */
  confidence: number;
  band: MappingBand;
  typeGuard: TypeGuard;
  /** Plain-English "why" — the rule that produced it. */
  reason: string;
  conflict: boolean;
}

// ── Certificate (TB, AR, AP, bank, equity) ──────────────────────────────────────

export type TieKey = 'tb' | 'ar' | 'ap' | 'bank' | 'equity';
export type TieStatus = 'tied' | 'difference' | 'not_applicable' | 'waiting';

export interface TieLine {
  label: string;
  sourceCents: number;
  meritCents: number;
  differenceCents: number;
}

export interface CertificateTie {
  key: TieKey;
  label: string;
  status: TieStatus;
  /** Plain-English result. */
  summary: string;
  lines: TieLine[];
  /** Outside evidence behind the tie (bank statement, aging report …). */
  evidence: 'evidenced' | 'internal_only' | 'not_applicable';
}

export interface CertificateGate {
  ready: boolean;
  /** Every reason the certificate can't be signed, in dollars. */
  blockers: string[];
}
