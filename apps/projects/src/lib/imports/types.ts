/**
 * Import engine DTOs (PLT-67/68). Pure and client-safe. The closed lists below mirror the CHECK
 * constraints of migration 1121 (pm.import_batches source_system / entity) — the engine test
 * asserts they stay identical to the SQL.
 */

export const SOURCE_SYSTEMS = [
  'BUILDERTREND', 'JOBTREAD', 'COCONSTRUCT', 'SERVICETITAN', 'FIELDEDGE', 'SIMPRO', 'HOUSECALL_PRO', 'JOBBER', 'CSYSTEMS',
  'PROCORE', 'EXCEL', 'QUICKBOOKS', 'CSV',
] as const;
export type SourceSystem = (typeof SOURCE_SYSTEMS)[number];

export const IMPORT_ENTITIES = [
  'customer', 'vendor', 'contact', 'site', 'employee', 'cost_item', 'job', 'budget', 'sov_line', 'commitment', 'change_order',
  'selection', 'file', 'equipment', 'service_history', 'open_ar', 'agreement', 'unit', 'rental_unit', 'part', 'repair_order',
  'special_order', 'warranty_claim', 'rental_contract', 'deposit',
] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];

/** What a commit does with the entity (pm.import_entity_disposition). */
export type Disposition = 'RECORD' | 'ROSTER' | 'FACT' | 'REFERENCE';

export type FieldType = 'text' | 'money' | 'signed_money' | 'date' | 'int' | 'number' | 'percent' | 'email' | 'phone' | 'enum' | 'bool';

export interface EnumOption {
  value: string;
  synonyms: readonly string[];
}

export interface TargetField {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  /** normalized header aliases, most specific first (generic, never a vendor name) */
  aliases: readonly string[];
  options?: readonly EnumOption[];
  max?: number;
}

export interface EntityDef {
  entity: ImportEntity;
  label: string;
  plural: string;
  disposition: Disposition;
  /** one-line plain description of what committing does */
  effect: string;
  fields: readonly TargetField[];
}

/** One export file a source system produces (a recipe). */
export interface AdapterEntity {
  entity: ImportEntity;
  /** "Customer list", "Open jobs (WIP)" */
  label: string;
  /** normalized headers whose presence identifies this export */
  signature: readonly string[];
  /** normalized source header → target field key */
  columns: Readonly<Record<string, string>>;
  /** fixture file in lib/imports/__fixtures__/ */
  fixture: string;
}

export type AdapterFamily = 'residential' | 'field_service' | 'dealer' | 'commercial' | 'accounting' | 'generic';

export interface SourceAdapter {
  id: SourceSystem;
  name: string;
  family: AdapterFamily;
  /** filename fragments (lowercase, letters only) that name the tool */
  fileHints: readonly string[];
  /** "how to export from X" steps (the illustrated card) */
  howToExport: readonly string[];
  /** Books owns this connection (QuickBooks comes in once through Books' QBO import, PLT-69) */
  viaBooks?: boolean;
  /** order the files are best brought in (dependencies first) */
  entities: readonly AdapterEntity[];
}

export type MappingSource = 'saved' | 'adapter' | 'alias' | 'fuzzy' | 'values' | 'ai' | 'user';

export interface MappedColumn {
  header: string;
  /** 0..1 */
  confidence: number;
  source: MappingSource;
}

/** field key → the column it reads */
export type ColumnMap = Record<string, MappedColumn>;

export interface UnsureColumn {
  field: string;
  label: string;
  required: boolean;
  /** the header we guessed (null = no guess) */
  header: string | null;
  confidence: number;
  /** a few sample cells of the guessed column */
  samples: string[];
  why: string;
}

export interface Issue {
  level: 'error' | 'warn';
  field?: string;
  message: string;
}

export type CellValue = string | number | boolean | null | string[];

export interface StagedRow {
  row_number: number;
  external_ref: string | null;
  data: Record<string, CellValue>;
  issues: Issue[];
  validation: 'VALID' | 'WARN' | 'INVALID';
}

export interface Detection {
  source: SourceSystem;
  entity: ImportEntity;
  /** 0..1 */
  confidence: number;
  reasons: string[];
  /** other plausible readings, best first */
  alternatives: { source: SourceSystem; entity: ImportEntity; confidence: number }[];
}

export interface ValidationReport {
  total: number;
  valid: number;
  warn: number;
  invalid: number;
  duplicates: number;
  /** per field: rows with a problem there */
  byField: Record<string, number>;
  topIssues: { message: string; count: number; rows: number[] }[];
  /** Σ of every money field across valid rows (cents) */
  totals: Record<string, number>;
}

export type AiOutcome = 'used' | 'paused' | 'skipped' | 'invalid';

export interface PreviewResult {
  fileName: string;
  fileHash: string;
  detection: Detection;
  source: SourceSystem;
  entity: ImportEntity;
  disposition: Disposition;
  headers: string[];
  headerRow: number;
  rowCount: number;
  truncated: boolean;
  mapping: ColumnMap;
  headerSignature: string;
  unsure: UnsureColumn[];
  unmappedHeaders: string[];
  rows: StagedRow[];
  report: ValidationReport;
  ai: { outcome: AiOutcome; mapped: number; message: string | null };
}

export interface JobTypeChoice {
  key: string;
  label: string;
  archetype: string;
}

export interface SavedMapping {
  source_system: SourceSystem;
  entity: ImportEntity;
  header_signature: string;
  mapping: Record<string, string>;
}

/** pm.import_commit result */
export interface CommitResult {
  batch_id: string;
  entity: ImportEntity;
  disposition: Disposition;
  status: 'COMMITTED';
  replayed: boolean;
  counts: Partial<Record<'CREATED' | 'MATCHED' | 'SKIPPED' | 'ERROR' | 'REFERENCE' | 'ROSTER' | 'FACT', number>>;
  errors: { row: number; ref: string | null; message: string }[];
  matched: { row: number; name: string | null; linked_to: string | null; score: number | null }[];
  first_job_id: string | null;
  importer_report?: Record<string, unknown>;
}

export interface StageResult {
  batch_id: string;
  status: 'STAGED' | 'COMMITTING' | 'COMMITTED';
  reused: boolean;
  row_count: number;
  valid_count: number;
  invalid_count: number;
  report?: Record<string, unknown>;
  result?: CommitResult;
}

export interface BatchSummary {
  id: string;
  source_system: SourceSystem;
  entity: ImportEntity;
  file_name: string | null;
  status: 'STAGED' | 'COMMITTING' | 'COMMITTED' | 'DISCARDED' | 'FAILED';
  row_count: number;
  valid_count: number;
  invalid_count: number;
  created_count: number;
  matched_count: number;
  skipped_count: number;
  error_count: number;
  created_at: string;
  committed_at: string | null;
}

export const OPENING_KINDS = ['JOB_WIP', 'AGREEMENT_DEFERRED', 'DEALER_UNITS', 'OPEN_AR', 'CUSTOMER_DEPOSITS', 'PARTS_INVENTORY', 'WARRANTY_RECEIVABLE'] as const;
export type OpeningKind = (typeof OPENING_KINDS)[number];

export interface TieLine {
  key: string;
  label: string;
  source_cents?: number | null;
  books_cents?: number | null;
  diff_cents?: number;
  status: 'ok' | 'pending' | 'exception' | 'missing_in_books' | 'missing_in_import' | 'cost_differs' | 'floor_differs' | 'lender_differs';
  [k: string]: unknown;
}

export interface TieOut {
  handoff_id: string;
  kind: OpeningKind;
  as_of_date: string;
  lines: TieLine[];
  controls: TieLine[];
  summary: { ok: number; pending: number; exceptions: number };
  generated_at: string;
}
