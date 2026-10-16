/**
 * Smart Intake — document type vocabulary + the type → destination map.
 *
 * CLIENT-SAFE (no server imports): the intake UI renders the "what we think it is"
 * label and the correct-the-type dropdown from this module, and the server classifier
 * (`classify.ts`), the deterministic fallback (`rules.ts`), and the handoff resolver
 * (`handoff.ts`) all share it, so the vocabulary can never drift between them.
 */

/** The canonical document types the intake can recognize. */
export type IntakeDocType =
  | 'TRIAL_BALANCE'
  | 'GENERAL_LEDGER'
  | 'FORMATION_DOC'
  | 'EIN_LETTER'
  | 'OPERATING_AGREEMENT'
  | 'LOAN'
  | 'BUDGET'
  | 'CUSTOMER_LIST'
  | 'AR_AGING'
  | 'VENDOR_LIST'
  | 'AP_AGING'
  | 'WIP_SCHEDULE'
  | 'ORG_CHART'
  | 'EXPENSE_POLICY'
  | 'LEASE'
  | 'BILL'
  | 'BANK_STATEMENT'
  | 'W9'
  | 'COI'
  | 'CUSTOMER_CONTRACT'
  | 'INSURANCE_POLICY'
  | 'PREPAID'
  | 'SUBSCRIPTION'
  | 'PAYROLL_REGISTER'
  | 'UNKNOWN';

/** One routing entry: the type, its human label, the destination page, and the parser (if any). */
export interface IntakeRoute {
  docType: IntakeDocType;
  label: string;
  /** The app page the document routes to. */
  route: string;
  /** The dedicated parse/import endpoint that receives the file, or null when none exists yet. */
  parseEndpoint: string | null;
}

/**
 * The authoritative type → destination map. Ordered the way the correct-the-type
 * dropdown lists them (the onboarding essentials first).
 */
export const INTAKE_ROUTES: Record<IntakeDocType, IntakeRoute> = {
  TRIAL_BALANCE: { docType: 'TRIAL_BALANCE', label: 'Trial Balance', route: '/onboarding', parseEndpoint: '/api/onboarding/import/tb' },
  GENERAL_LEDGER: { docType: 'GENERAL_LEDGER', label: 'General Ledger Export', route: '/onboarding', parseEndpoint: '/api/onboarding/import/tb' },
  FORMATION_DOC: {
    docType: 'FORMATION_DOC',
    label: 'Articles / Certificate of Formation',
    route: '/onboarding',
    parseEndpoint: '/api/onboarding/formation/parse',
  },
  EIN_LETTER: { docType: 'EIN_LETTER', label: 'EIN Letter (CP-575 / SS-4)', route: '/onboarding', parseEndpoint: '/api/onboarding/formation/parse' },
  OPERATING_AGREEMENT: {
    docType: 'OPERATING_AGREEMENT',
    label: 'Operating Agreement',
    route: '/onboarding',
    parseEndpoint: '/api/onboarding/formation/parse',
  },
  LOAN: { docType: 'LOAN', label: 'Loan / Credit Agreement', route: '/debt', parseEndpoint: '/api/debt/parse' },
  BUDGET: { docType: 'BUDGET', label: 'Budget', route: '/budgets', parseEndpoint: '/api/budgets/import' },
  CUSTOMER_LIST: { docType: 'CUSTOMER_LIST', label: 'Customer List / CRM Export', route: '/onboarding/sections/customers-ar', parseEndpoint: '/api/onboarding/import/ar' },
  AR_AGING: { docType: 'AR_AGING', label: 'Open Receivables (A/R Aging)', route: '/onboarding/sections/customers-ar', parseEndpoint: '/api/onboarding/import/ar' },
  VENDOR_LIST: { docType: 'VENDOR_LIST', label: 'Vendor List', route: '/onboarding/sections/vendors-ap', parseEndpoint: '/api/onboarding/import/ap' },
  AP_AGING: { docType: 'AP_AGING', label: 'Open Payables (A/P Aging)', route: '/onboarding/sections/vendors-ap', parseEndpoint: '/api/onboarding/import/ap' },
  WIP_SCHEDULE: { docType: 'WIP_SCHEDULE', label: 'WIP Schedule', route: '/onboarding/sections/jobs-wip', parseEndpoint: '/api/onboarding/import/wip' },
  ORG_CHART: { docType: 'ORG_CHART', label: 'Org Chart', route: '/documents', parseEndpoint: null },
  EXPENSE_POLICY: { docType: 'EXPENSE_POLICY', label: 'Expense Policy', route: '/documents', parseEndpoint: null },
  LEASE: { docType: 'LEASE', label: 'Lease Agreement', route: '/leases', parseEndpoint: '/api/leases/parse' },
  BILL: { docType: 'BILL', label: 'Vendor Bill / Invoice', route: '/bills', parseEndpoint: '/api/bills/parse' },
  BANK_STATEMENT: { docType: 'BANK_STATEMENT', label: 'Bank Statement', route: '/bank-feed', parseEndpoint: '/api/bank-feed/import-statement' },
  W9: { docType: 'W9', label: 'Form W-9', route: '/vendors', parseEndpoint: '/api/vendors/w9-parse' },
  COI: { docType: 'COI', label: 'Certificate of Insurance', route: '/vendor-compliance', parseEndpoint: '/api/vendors/coi-parse' },
  CUSTOMER_CONTRACT: { docType: 'CUSTOMER_CONTRACT', label: 'Customer Contract', route: '/invoices', parseEndpoint: '/api/invoices/parse-contract' },
  INSURANCE_POLICY: { docType: 'INSURANCE_POLICY', label: 'Insurance Policy', route: '/insurance', parseEndpoint: '/api/insurance/parse' },
  PREPAID: { docType: 'PREPAID', label: 'Prepaid Expense Document', route: '/prepaids', parseEndpoint: '/api/prepaid/parse' },
  SUBSCRIPTION: { docType: 'SUBSCRIPTION', label: 'Subscription Agreement', route: '/subscriptions', parseEndpoint: '/api/subscriptions/parse-agreement' },
  PAYROLL_REGISTER: { docType: 'PAYROLL_REGISTER', label: 'Payroll Register', route: '/payroll', parseEndpoint: '/api/payroll/import-register' },
  UNKNOWN: { docType: 'UNKNOWN', label: 'Not sure yet', route: '/onboarding', parseEndpoint: null },
};

/** All doc types in dropdown order. */
export const INTAKE_DOC_TYPES: IntakeDocType[] = Object.keys(INTAKE_ROUTES) as IntakeDocType[];

const DOC_TYPE_SET: ReadonlySet<string> = new Set(INTAKE_DOC_TYPES);

export function isIntakeDocType(v: unknown): v is IntakeDocType {
  return typeof v === 'string' && DOC_TYPE_SET.has(v);
}

/**
 * Coerce a loose docType string to a canonical IntakeDocType. Uppercases, folds
 * spaces/hyphens to underscores, strips other punctuation, and only accepts an exact
 * match — anything else (empty, garbled, hallucinated) falls to UNKNOWN.
 */
export function mapDocType(raw: unknown): IntakeDocType {
  if (typeof raw !== 'string') return 'UNKNOWN';
  const normalized = raw.trim().toUpperCase().replace(/[\s-]+/g, '_').replace(/[^A-Z0-9_]/g, '');
  return isIntakeDocType(normalized) ? normalized : 'UNKNOWN';
}

/** Where a classification came from — shown to the user so "AI off" is never a mystery. */
export type ClassificationSource = 'ai' | 'rules' | 'user';
