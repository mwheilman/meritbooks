/**
 * Onboarding DTOs shared by the routes and the client flow. Type-only imports from
 * the pack package, so this file is safe in client components (no node:crypto).
 */
import type { ModuleKey } from '@meritbooks/industry-packs';

export type StepKey = 'select' | 'describe' | 'preview' | 'bring_work' | 'team' | 'done';
/** pm.onboarding_runs.step CHECK: describe | preview | bring_work | team | done */
export type RunStep = Exclude<StepKey, 'select'>;
export type RunStatus = 'IN_PROGRESS' | 'APPLIED' | 'COMPLETE' | 'ABANDONED';

export type AiOutcome = 'used' | 'skipped' | 'unavailable' | 'blocked' | 'invalid';

export interface PackTile {
  key: string;
  name: string;
  label: string;
  examples: string;
  tagline: string;
}

export interface BooksGuess {
  packKey: string;
  label: string;
  /** 0..100 */
  confidence: number;
  reasons: string[];
}

export interface CompanyBrief {
  id: string;
  name: string;
  shortCode: string | null;
  industry: string | null;
  revRecMethod: string | null;
  /** core.jobs rows on this company */
  jobCount: number;
  /** core.jobs rows with no pm.projects extension yet */
  unadoptedJobCount: number;
  installed: { packKey: string; version: string; name: string; installId: string } | null;
  run: RunBrief | null;
  booksGuess: BooksGuess | null;
  preselect: { selected: boolean; reasons: string[] };
}

export interface RunBrief {
  id: string;
  status: RunStatus;
  step: RunStep;
  inputs: RunInputs;
  classification: ClassifyResponse | null;
  aiDecisionId: string | null;
  installId: string | null;
}

/** What we keep in pm.onboarding_runs.inputs (resumable). */
export interface RunInputs {
  mode?: 'first' | 'change';
  description?: string;
  tilePackKey?: string | null;
  fileHeaders?: string[];
  fileName?: string | null;
  plan?: PlanInputs;
  /** org-level run (location_id null) only */
  selectedCompanyIds?: string[];
  sampleJobId?: string | null;
  firstJobId?: string | null;
}

export interface CandidateDTO {
  packKey: string;
  name: string;
  tileLabel: string;
  /** 0..100 */
  confidence: number;
  reasons: string[];
  source: 'tile' | 'rules' | 'ai' | 'merged';
}

export type AnswerValue = boolean | number | string | string[];

export interface ClassifyRequest {
  companyId: string;
  description?: string;
  tilePackKey?: string | null;
  fileHeaders?: string[];
  fileName?: string | null;
}

export interface ClassifyResponse {
  candidates: CandidateDTO[];
  abstain: boolean;
  source: 'tile' | 'rules' | 'ai' | 'merged';
  ai: { outcome: AiOutcome; message: string | null };
  /** quotes from the user's own words that the AI cited and we verified */
  evidence: string[];
  /** the pack the AI ranked first (its prefilled answers were validated against it) */
  aiPackKey: string | null;
  /** AI-prefilled answers (verified) for `aiPackKey` */
  prefilledAnswers: Record<string, { value: AnswerValue; evidence: string }>;
  params: Record<string, boolean | number | string>;
  paramsPackKey: string | null;
  decisionId: string | null;
  /** how many AI claims we dropped (unknown packs, fabricated quotes, bad params) */
  rejected: number;
}

export interface PlanInputs {
  companyId: string;
  packKey: string;
  addons: string[];
  params?: Record<string, unknown>;
  answers?: Record<string, unknown>;
  moduleOverrides?: Partial<Record<ModuleKey, boolean>>;
  aiDecisionId?: string | null;
}

export interface QuestionDTO {
  /** answer key as the compiler expects it ("q" or "addon_key.q") */
  key: string;
  packKey: string;
  prompt: string;
  help: string | null;
  type: 'bool' | 'choice' | 'multi' | 'percent';
  options: { value: string; label: string }[];
  min: number | null;
  max: number | null;
  value: AnswerValue;
  /** "Suggested from your description" — the quoted phrase */
  suggestedFrom: string | null;
}

export interface ModuleDTO {
  key: ModuleKey;
  label: string;
  on: boolean;
  overridden: boolean;
}

export interface JobTypeDTO {
  key: string;
  label: string;
  archetype: string;
  stages: string[];
  exits: string[];
  billing: string;
}

export interface CardDTO {
  section: string;
  title: string;
  summary: string;
  items: string[];
}

export interface DiffSummary {
  identical: boolean;
  lines: { section: string; added: string[]; removed: string[]; changed: string[] }[];
}

export interface PlanPreview {
  packKey: string;
  packName: string;
  version: string;
  planHash: string;
  vocabularyHeadline: string;
  jobsWord: string;
  cards: CardDTO[];
  jobTypes: JobTypeDTO[];
  costCodes: { count: number; items: { code: string; name: string; costType: string }[] };
  modules: ModuleDTO[];
  kpis: string[];
  questions: QuestionDTO[];
  addonOptions: { key: string; name: string; label: string; suggested: boolean; reason: string | null }[];
  diff: DiffSummary | null;
  sampleJob: { name: string; customerName: string; contractCents: number } | null;
}

export interface ApplyResponse {
  installId: string;
  planHash: string;
  decisionApproved: boolean;
  nextStep: RunStep;
}

// ---------------------------------------------------------------- import

export const IMPORT_FIELDS = ['name', 'external_id', 'customer', 'job_type', 'contract', 'start_date', 'status', 'site_address'] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export interface MappedColumn {
  header: string;
  /** 0..1 */
  confidence: number;
  source: 'alias' | 'fuzzy' | 'values' | 'ai' | 'user';
}

export type ColumnMapping = Partial<Record<ImportField, MappedColumn>>;

export type ImportStatus = 'bid' | 'active' | 'on_hold' | 'complete' | 'cancelled';

export interface ImportRow {
  rowNumber: number;
  name: string;
  externalId: string | null;
  customer: string | null;
  jobTypeRaw: string | null;
  jobTypeKey: string;
  jobTypeMatched: boolean;
  contractCents: number | null;
  startDate: string | null;
  statusRaw: string | null;
  status: ImportStatus | null;
  siteAddress: string | null;
  sourceRef: string;
  issues: string[];
  /** finished/cancelled rows are skipped by default ("bring open work only") */
  finished: boolean;
  invalid: boolean;
}

export interface ParseResponse {
  fileName: string;
  vendor: string | null;
  headers: string[];
  headerRow: number;
  rowCount: number;
  truncated: boolean;
  mapping: ColumnMapping;
  unmappedHeaders: string[];
  ai: { outcome: AiOutcome; message: string | null; mapped: number };
  /** raw records (header → cell), capped */
  records: Record<string, string>[];
  rowNumbers: number[];
  /** PROPOSED ai_decisions row for AI-mapped columns (approved when the import is confirmed) */
  aiDecisionId: string | null;
}

export interface CommitRowResult {
  rowNumber: number;
  name: string;
  status: 'created' | 'skipped' | 'error';
  jobId: string | null;
  message: string | null;
}

export interface TeamMember {
  id: string;
  name: string;
  title: string | null;
  email: string | null;
  role: string | null;
}
