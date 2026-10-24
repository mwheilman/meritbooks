/**
 * Document intelligence — vocabulary + the routing table (FPB-document-intelligence §4–§5).
 *
 * CLIENT-SAFE (no server imports): the Documents center, the module banners, the
 * onboarding intake card, the server classifier, the router and the migration 188
 * CHECKs all share this vocabulary, so it can never drift between them.
 */

import type { FeatureAction } from '@/lib/rbac/permissions';

// ── Classes (migration 188 document_intelligence.doc_class CHECK) ────────────
export const DOC_CLASSES = [
  'lease',
  'loan',
  'insurance_policy',
  'coi',
  'w9',
  'vendor_bill',
  'customer_contract',
  'purchase_order',
  'bank_statement',
  'card_statement',
  'payroll_register',
  'fixed_asset_invoice',
  'subscription',
  'formation',
  'tax_document',
  'form_1099',
  'budget',
  'prepaid',
  'ledger_report',
  'other',
] as const;
export type DocClass = (typeof DOC_CLASSES)[number];

const CLASS_SET: ReadonlySet<string> = new Set(DOC_CLASSES);
export function isDocClass(v: unknown): v is DocClass {
  return typeof v === 'string' && CLASS_SET.has(v);
}

/** Coerce a loose model answer ("Lease Agreement", "LOAN", "vendor-bill") to a class; else 'other'. */
export function mapDocClass(raw: unknown): DocClass {
  if (typeof raw !== 'string') return 'other';
  const n = raw.trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');
  if (isDocClass(n)) return n;
  const ALIASES: Record<string, DocClass> = {
    lease_agreement: 'lease',
    note: 'loan',
    promissory_note: 'loan',
    credit_agreement: 'loan',
    loan_agreement: 'loan',
    policy: 'insurance_policy',
    insurance: 'insurance_policy',
    certificate_of_insurance: 'coi',
    form_w9: 'w9',
    w_9: 'w9',
    bill: 'vendor_bill',
    invoice: 'vendor_bill',
    vendor_invoice: 'vendor_bill',
    contract: 'customer_contract',
    sow: 'customer_contract',
    msa: 'customer_contract',
    po: 'purchase_order',
    statement: 'bank_statement',
    credit_card_statement: 'card_statement',
    payroll: 'payroll_register',
    asset_invoice: 'fixed_asset_invoice',
    saas_agreement: 'subscription',
    operating_agreement: 'formation',
    articles: 'formation',
    cap_table: 'formation',
    tax_return: 'tax_document',
    tax_notice: 'tax_document',
    '1099': 'form_1099',
    trial_balance: 'ledger_report',
    unknown: 'other',
  };
  return ALIASES[n] ?? 'other';
}

export const DOC_CLASS_LABEL: Record<DocClass, string> = {
  lease: 'Lease',
  loan: 'Loan / note',
  insurance_policy: 'Insurance policy',
  coi: 'Certificate of insurance',
  w9: 'W-9',
  vendor_bill: 'Vendor bill',
  customer_contract: 'Customer contract',
  purchase_order: 'Purchase order',
  bank_statement: 'Bank statement',
  card_statement: 'Card statement',
  payroll_register: 'Payroll register',
  fixed_asset_invoice: 'Equipment invoice',
  subscription: 'Subscription',
  formation: 'Formation / ownership',
  tax_document: 'Tax return / notice',
  form_1099: '1099',
  budget: 'Budget',
  prepaid: 'Prepaid expense',
  ledger_report: 'Ledger / aging report',
  other: 'Other',
};

/** The coarse `public.documents.doc_type` bucket (migration 090 CHECK) for each class. */
export type DocumentsDocType = 'BILL' | 'RECEIPT' | 'CONTRACT' | 'LEASE' | 'LOAN' | 'POLICY' | 'W9' | 'COI' | 'STATEMENT' | 'OTHER';
export const CLASS_TO_DOC_TYPE: Record<DocClass, DocumentsDocType> = {
  lease: 'LEASE',
  loan: 'LOAN',
  insurance_policy: 'POLICY',
  coi: 'COI',
  w9: 'W9',
  vendor_bill: 'BILL',
  customer_contract: 'CONTRACT',
  purchase_order: 'OTHER',
  bank_statement: 'STATEMENT',
  card_statement: 'STATEMENT',
  payroll_register: 'OTHER',
  fixed_asset_invoice: 'BILL',
  subscription: 'CONTRACT',
  formation: 'CONTRACT',
  tax_document: 'OTHER',
  form_1099: 'OTHER',
  budget: 'OTHER',
  prepaid: 'OTHER',
  ledger_report: 'OTHER',
  other: 'OTHER',
};

// ── Statuses ────────────────────────────────────────────────────────────────
export type IntelligenceStatus =
  | 'queued'
  | 'classified'
  | 'routed'
  | 'proposal_created'
  | 'accepted'
  | 'linked'
  | 'dismissed'
  | 'needs_review'
  | 'duplicate';

export type AiState = 'pending' | 'done' | 'unavailable' | 'failed' | 'budget_blocked' | 'skipped';
export type ClassSource = 'ai' | 'rules' | 'user';
export type LocationSource = 'ai' | 'rules' | 'user' | 'single_company' | 'upload';
export type IntelligenceSource = 'center' | 'onboarding' | 'email' | 'portal' | 'backfill' | 'module';

export const STATUS_LABEL: Record<IntelligenceStatus, string> = {
  queued: 'Waiting to be read',
  classified: 'Typed',
  routed: 'Filed',
  proposal_created: 'Proposal ready',
  accepted: 'Accepted',
  linked: 'Linked',
  dismissed: 'Dismissed',
  needs_review: 'Needs review',
  duplicate: 'Duplicate',
};

// ── Targets (migration 188 document_proposals.target_kind CHECK) ─────────────
export const TARGET_KINDS = [
  'lease',
  'debt_instrument',
  'insurance_policy',
  'prepaid',
  'subscription',
  'customer_contract',
  'fixed_asset',
  'bill',
  'vendor_coi',
  'vendor_w9',
  'payroll_register',
  'bank_statement',
  'formation',
  'budget',
  'filed',
] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];
export function isTargetKind(v: unknown): v is TargetKind {
  return typeof v === 'string' && (TARGET_KINDS as readonly string[]).includes(v);
}

export type ProposalMode = 'staged' | 'native' | 'route';
export type ProposalStatus = 'pending' | 'accepted' | 'dismissed' | 'superseded' | 'failed';
export type ExtractState = 'done' | 'pending' | 'failed' | 'not_needed';

export interface TargetSpec {
  kind: TargetKind;
  mode: ProposalMode;
  /** Singular noun for copy: "1 lease found in your documents". */
  noun: string;
  nounPlural: string;
  /** The module page that receives it. */
  href: string;
  /** The module label: "Leases". */
  moduleLabel: string;
  /** The record type written to document_links / documents.entity_type when accepted. */
  recordType: string;
  /** Permission needed to accept / dismiss / link (the module's own create gate). */
  permission: { feature: string; action: FeatureAction };
  /** The existing extractor feature key (null when the module imports it itself). */
  extractorFeature: string | null;
}

export const TARGETS: Record<TargetKind, TargetSpec> = {
  lease: { kind: 'lease', mode: 'staged', noun: 'lease', nounPlural: 'leases', href: '/leases', moduleLabel: 'Leases', recordType: 'lease', permission: { feature: 'journal_entries', action: 'create' }, extractorFeature: 'LEASE_EXTRACT' },
  debt_instrument: { kind: 'debt_instrument', mode: 'staged', noun: 'loan', nounPlural: 'loans', href: '/debt', moduleLabel: 'Debt', recordType: 'debt_instrument', permission: { feature: 'journal_entries', action: 'post' }, extractorFeature: 'DEBT_EXTRACT' },
  insurance_policy: { kind: 'insurance_policy', mode: 'staged', noun: 'insurance policy', nounPlural: 'insurance policies', href: '/insurance', moduleLabel: 'Insurance', recordType: 'policy', permission: { feature: 'journal_entries', action: 'create' }, extractorFeature: 'INSURANCE_EXTRACT' },
  prepaid: { kind: 'prepaid', mode: 'staged', noun: 'prepaid expense', nounPlural: 'prepaid expenses', href: '/prepaids', moduleLabel: 'Prepaids', recordType: 'prepaid', permission: { feature: 'journal_entries', action: 'create' }, extractorFeature: 'PREPAID_EXTRACT' },
  subscription: { kind: 'subscription', mode: 'staged', noun: 'subscription', nounPlural: 'subscriptions', href: '/subscriptions', moduleLabel: 'Subscriptions', recordType: 'subscription', permission: { feature: 'bills', action: 'create' }, extractorFeature: 'SUBSCRIPTION_EXTRACT' },
  customer_contract: { kind: 'customer_contract', mode: 'staged', noun: 'customer contract', nounPlural: 'customer contracts', href: '/invoices', moduleLabel: 'Invoices', recordType: 'customer_contract', permission: { feature: 'invoices', action: 'create' }, extractorFeature: 'CONTRACT_EXTRACT' },
  fixed_asset: { kind: 'fixed_asset', mode: 'staged', noun: 'fixed asset', nounPlural: 'fixed assets', href: '/fixed-assets', moduleLabel: 'Fixed assets', recordType: 'fixed_asset', permission: { feature: 'fixed_assets', action: 'create' }, extractorFeature: 'ASSET_EXTRACT' },
  bill: { kind: 'bill', mode: 'native', noun: 'bill', nounPlural: 'bills', href: '/bills/intake-queue', moduleLabel: 'Bills intake', recordType: 'bill', permission: { feature: 'bills', action: 'create' }, extractorFeature: 'AP_DOC_INTAKE' },
  vendor_coi: { kind: 'vendor_coi', mode: 'native', noun: 'certificate of insurance', nounPlural: 'certificates of insurance', href: '/vendor-compliance', moduleLabel: 'Vendor compliance', recordType: 'vendor', permission: { feature: 'vendors', action: 'edit' }, extractorFeature: 'COI_EXTRACT' },
  vendor_w9: { kind: 'vendor_w9', mode: 'native', noun: 'W-9', nounPlural: 'W-9s', href: '/vendor-compliance', moduleLabel: 'Vendor compliance', recordType: 'vendor', permission: { feature: 'vendors', action: 'edit' }, extractorFeature: null },
  payroll_register: { kind: 'payroll_register', mode: 'route', noun: 'payroll register', nounPlural: 'payroll registers', href: '/payroll', moduleLabel: 'Payroll', recordType: 'payroll_run', permission: { feature: 'payroll', action: 'create' }, extractorFeature: null },
  bank_statement: { kind: 'bank_statement', mode: 'route', noun: 'statement', nounPlural: 'statements', href: '/bank-feed', moduleLabel: 'Bank feed', recordType: 'bank_account', permission: { feature: 'bank_feed', action: 'edit' }, extractorFeature: null },
  formation: { kind: 'formation', mode: 'route', noun: 'formation document', nounPlural: 'formation documents', href: '/onboarding', moduleLabel: 'Company setup', recordType: 'location', permission: { feature: 'settings_acct', action: 'edit' }, extractorFeature: null },
  budget: { kind: 'budget', mode: 'route', noun: 'budget', nounPlural: 'budgets', href: '/budgets', moduleLabel: 'Budgets', recordType: 'budget', permission: { feature: 'settings_acct', action: 'edit' }, extractorFeature: null },
  filed: { kind: 'filed', mode: 'route', noun: 'document', nounPlural: 'documents', href: '/documents', moduleLabel: 'Documents', recordType: 'location', permission: { feature: 'audit_trail', action: 'view' }, extractorFeature: null },
};

/**
 * The record types a proposal of each kind may be ACCEPTED onto (security review M:
 * a lease proposal can only ever close onto a lease). A customer contract becomes a
 * recurring template or an invoice; every other kind closes onto its own record type.
 */
function acceptTypes(): Record<TargetKind, readonly string[]> {
  const out = {} as Record<TargetKind, readonly string[]>;
  for (const k of TARGET_KINDS) out[k] = k === 'customer_contract' ? [TARGETS[k].recordType, 'invoice'] : [TARGETS[k].recordType];
  return out;
}
export const ACCEPT_RECORD_TYPES: Record<TargetKind, readonly string[]> = acceptTypes();

export function acceptableRecordType(kind: TargetKind, recordType: string): boolean {
  return ACCEPT_RECORD_TYPES[kind].includes(recordType);
}

/** A draft not made because the person who ran the read can't act in that module. */
export function needsAccessMessage(kind: TargetKind): string {
  return `Waiting for someone with access to ${TARGETS[kind].moduleLabel} — it was not read into a draft for you.`;
}

/** The routing table: which module proposals a class produces (in order). */
export const CLASS_TARGETS: Record<DocClass, TargetKind[]> = {
  lease: ['lease'],
  loan: ['debt_instrument'],
  insurance_policy: ['insurance_policy'],
  coi: ['vendor_coi'],
  w9: ['vendor_w9'],
  vendor_bill: ['bill'],
  customer_contract: ['customer_contract'],
  purchase_order: ['filed'],
  bank_statement: ['bank_statement'],
  card_statement: ['bank_statement'],
  payroll_register: ['payroll_register'],
  // An equipment invoice is both a fixed asset to set up and a bill to pay.
  fixed_asset_invoice: ['fixed_asset', 'bill'],
  subscription: ['subscription'],
  formation: ['formation'],
  tax_document: ['filed'],
  form_1099: ['filed'],
  budget: ['budget'],
  prepaid: ['prepaid'],
  ledger_report: ['filed'],
  other: [],
};

/** Confidence at or above which a deterministic (rules-only) class is routed without a person. */
export const ROUTE_MIN_CONFIDENCE = 0.6;
/** A W-9 typed by rules at or above this is never sent to AI (vendor-compliance decision D6). */
export const W9_NO_AI_CONFIDENCE = 0.8;
/** Max AI attempts per document before the retry job leaves it to a person. */
export const MAX_AI_ATTEMPTS = 6;

/** One plain-English line for the onboarding card / a toast. */
export function foundMessage(docClass: DocClass, kinds: TargetKind[], extractPending: boolean): string {
  const label = DOC_CLASS_LABEL[docClass].toLowerCase();
  const staged = kinds.filter((k) => TARGETS[k].mode !== 'route');
  if (staged.length === 0) {
    if (kinds.length === 0) return 'Kept on file — we couldn’t tell what it is yet. Tell us any time and we’ll put it to work.';
    const t = TARGETS[kinds[0]];
    return t.kind === 'filed'
      ? `We found a ${label} — filed in your documents.`
      : `We found a ${label} — filed and linked to ${t.moduleLabel}.`;
  }
  const where = staged.map((k) => TARGETS[k].moduleLabel).filter((v, i, a) => a.indexOf(v) === i).join(' and ');
  const article = /^[aeiou]/.test(label) ? 'an' : 'a';
  return extractPending
    ? `We found ${article} ${label} — added to ${where} for your review. AI will read the terms when it’s available.`
    : `We found ${article} ${label} — added to ${where} for your review.`;
}

/** Map a Smart Intake type (onboarding) to a class. */
export function classFromIntakeType(t: string): DocClass {
  const M: Record<string, DocClass> = {
    TRIAL_BALANCE: 'ledger_report',
    GENERAL_LEDGER: 'ledger_report',
    FORMATION_DOC: 'formation',
    EIN_LETTER: 'formation',
    OPERATING_AGREEMENT: 'formation',
    LOAN: 'loan',
    BUDGET: 'budget',
    CUSTOMER_LIST: 'other',
    AR_AGING: 'ledger_report',
    VENDOR_LIST: 'other',
    AP_AGING: 'ledger_report',
    WIP_SCHEDULE: 'ledger_report',
    ORG_CHART: 'other',
    EXPENSE_POLICY: 'other',
    LEASE: 'lease',
    BILL: 'vendor_bill',
    BANK_STATEMENT: 'bank_statement',
    W9: 'w9',
    COI: 'coi',
    CUSTOMER_CONTRACT: 'customer_contract',
    INSURANCE_POLICY: 'insurance_policy',
    PREPAID: 'prepaid',
    SUBSCRIPTION: 'subscription',
    PAYROLL_REGISTER: 'payroll_register',
    UNKNOWN: 'other',
  };
  return M[t] ?? 'other';
}

/** The class a center upload's chosen coarse type implies (null = let the read decide). */
export function presetFromDocType(t: DocumentsDocType): { docClass: DocClass; confidence: number; source: 'user' | 'rules' } | null {
  switch (t) {
    case 'BILL': return { docClass: 'vendor_bill', confidence: 1, source: 'user' };
    case 'LEASE': return { docClass: 'lease', confidence: 1, source: 'user' };
    case 'LOAN': return { docClass: 'loan', confidence: 1, source: 'user' };
    case 'POLICY': return { docClass: 'insurance_policy', confidence: 1, source: 'user' };
    case 'W9': return { docClass: 'w9', confidence: 1, source: 'user' };
    case 'COI': return { docClass: 'coi', confidence: 1, source: 'user' };
    case 'STATEMENT': return { docClass: 'bank_statement', confidence: 0.7, source: 'rules' };
    case 'CONTRACT': return { docClass: 'customer_contract', confidence: 0.55, source: 'rules' };
    default: return null;
  }
}

// ── DTOs returned by the API (shared by server + client) ─────────────────────
export interface IntelligenceDto {
  id: string;
  document_id: string;
  location_id: string | null;
  location_source: LocationSource | null;
  doc_class: DocClass;
  confidence: number;
  class_source: ClassSource;
  status: IntelligenceStatus;
  ai_status: AiState;
  ai_attempts: number;
  next_retry_at: string | null;
  counterparty: string | null;
  key_dates: Record<string, string>;
  amount_cents: number | null;
  summary: string | null;
  reason: string | null;
  duplicate_of: string | null;
  source: IntelligenceSource;
  classified_at: string | null;
  updated_at: string;
}

/** A proposal as list endpoints return it: no `payload` (the extracted terms — detail only). */
export interface ProposalSummaryDto {
  id: string;
  document_id: string;
  location_id: string | null;
  target_kind: TargetKind;
  mode: ProposalMode;
  status: ProposalStatus;
  extract_state: ExtractState;
  title: string | null;
  summary: string | null;
  confidence: number | null;
  native_table: string | null;
  native_id: string | null;
  target_href: string | null;
  accepted_target_type: string | null;
  accepted_target_id: string | null;
  last_error: string | null;
  created_at: string;
}

/** A proposal with its extracted terms (the detail endpoint; redacted). */
export interface ProposalDto extends ProposalSummaryDto {
  payload: Record<string, unknown>;
}

export interface LinkDto {
  id: string;
  document_id: string;
  target_type: string;
  target_id: string;
  link_kind: 'source' | 'supporting';
  created_via: 'ai' | 'user' | 'module';
  label: string | null;
  created_at: string;
}
