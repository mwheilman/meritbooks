/**
 * Core database types for MeritBooks.
 * These mirror the SQL schema and are used across the entire application.
 * Generated types from `supabase gen types` will extend/replace these.
 */

// =============================================================
// ENUMS
// =============================================================

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'COGS' | 'OPEX' | 'OTHER';

export type AccountSubType =
  | 'CURRENT_ASSET' | 'FIXED_ASSET' | 'OTHER_ASSET'
  | 'CURRENT_LIABILITY' | 'LONG_TERM_LIABILITY'
  | 'EQUITY'
  | 'REVENUE'
  | 'COST_OF_GOODS_SOLD'
  | 'OPERATING_EXPENSE'
  | 'OTHER_INCOME' | 'OTHER_EXPENSE';

export type ApprovalStatus = 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED';

export type TransactionStatus = 'PENDING' | 'CATEGORIZED' | 'APPROVED' | 'POSTED' | 'FLAGGED' | 'POST_ERROR' | 'VOIDED';

export type EntryType = 'STANDARD' | 'ADJUSTING' | 'CLOSING' | 'REVERSING' | 'RECURRING' | 'SYSTEM';

export type PeriodStatus = 'OPEN' | 'SOFT_CLOSE' | 'HARD_CLOSE';

export type RevRecMethod = 'PCT_COSTS_INCURRED' | 'PCT_COMPLETE' | 'COMPLETED_CONTRACT' | 'POINT_OF_SALE';

export type DepreciationMethod =
  | 'STRAIGHT_LINE' | 'DOUBLE_DECLINING'
  | 'MACRS_3' | 'MACRS_5' | 'MACRS_7' | 'MACRS_10' | 'MACRS_15' | 'MACRS_20';

export type ClosePhase = 'INITIAL' | 'MID_CLOSE' | 'FINAL';

// Session 12 — inter-department model
export type InternalChargeMethod = 'inherit' | 'revenue' | 'cost_transfer';
export type CompanyChargeMethod = 'revenue' | 'cost_transfer';
export type InternalInvoiceStatus = 'draft' | 'sent' | 'approved' | 'booked' | 'rejected' | 'void';

// =============================================================
// CORE ENTITIES
// =============================================================

export interface Organization {
  id: string;
  name: string;
  slug: string;
  primary_contact_name: string | null;
  primary_contact_email: string | null;
  timezone: string;
  fiscal_year_start_month: number;
  setup_complete: boolean;
  chase_first_reminder_minutes: number;
  chase_followup_minutes: number;
  chase_escalation_threshold: number;
  chase_auto_approve_cents: number;
  ai_auto_approve_threshold: number;
  ai_auto_approve_max_cents: number;
  created_at: string;
  updated_at: string;
}

export interface Location {
  id: string;
  org_id: string;
  name: string;
  short_code: string;
  industry: string | null;
  fiscal_year_start_month: number;
  rev_rec_method: RevRecMethod;
  default_internal_charge_method: CompanyChargeMethod;
  minimum_cash_cents: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Account {
  id: string;
  org_id: string;
  account_group_id: string;
  account_number: string;
  name: string;
  description: string | null;
  account_type: AccountType;
  account_sub_type: AccountSubType;
  is_active: boolean;
  is_control_account: boolean;
  is_company_specific: boolean;
  company_location_id: string | null;
  is_bank_account: boolean;
  is_credit_card: boolean;
  require_department: boolean;
  require_class: boolean;
  require_item: boolean;
  approval_status: ApprovalStatus;
  display_order: number;
  created_at: string;
  updated_at: string;
}

export interface Department {
  id: string;
  org_id: string;
  location_id: string | null;
  name: string;
  code: string | null;
  parent_department_id: string | null;
  internal_charge_method: InternalChargeMethod;
  is_active: boolean;
  created_at: string;
}

// =============================================================
// GL ENTRIES
// =============================================================

export interface GlEntry {
  id: string;
  org_id: string;
  location_id: string;
  entry_number: string;
  entry_date: string;
  entry_type: EntryType;
  fiscal_period_id: string;
  memo: string | null;
  source_module: string | null;
  source_id: string | null;
  status: TransactionStatus;
  posted_at: string | null;
  posted_by: string | null;
  is_reversing: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface GlEntryLine {
  id: string;
  org_id: string;
  gl_entry_id: string;
  line_number: number;
  account_id: string;
  debit_cents: number;
  credit_cents: number;
  location_id: string;
  department_id: string | null;
  class_id: string | null;
  item_id: string | null;
  memo: string | null;
  quantity: number | null;
  unit_cost_cents: number | null;
  created_at: string;
}

// =============================================================
// TRANSACTIONS
// =============================================================

export interface Vendor {
  id: string;
  org_id: string;
  name: string;
  display_name: string | null;
  default_account_id: string | null;
  ai_confidence: number;
  auto_approve: boolean;
  transaction_count: number;
  ytd_spend_cents: number;
  is_1099_eligible: boolean;
  payment_terms_days: number;
  is_active: boolean;
  created_at: string;
}

export interface BankTransaction {
  id: string;
  org_id: string;
  bank_account_id: string;
  location_id: string;
  transaction_date: string;
  description: string;
  amount_cents: number;
  status: TransactionStatus;
  ai_account_id: string | null;
  ai_confidence: number | null;
  final_account_id: string | null;
  final_vendor_id: string | null;
  match_type: 'VENDOR_PATTERN' | 'BILL_PAYMENT' | 'RECEIPT' | 'NONE' | null;
  match_confidence: number | null;
  gl_entry_id: string | null;
  created_at: string;
}

export interface Bill {
  id: string;
  org_id: string;
  location_id: string;
  vendor_id: string;
  bill_number: string | null;
  bill_date: string;
  due_date: string;
  total_cents: number;
  amount_paid_cents: number;
  balance_cents: number;
  status: string;
  ai_extracted: boolean;
  ai_confidence: number | null;
  gl_entry_id: string | null;
  created_at: string;
}

export interface Receipt {
  id: string;
  org_id: string;
  location_id: string;
  source: 'MOBILE_CAPTURE' | 'EMAIL' | 'MANUAL_UPLOAD';
  image_url: string | null;
  vendor_name: string | null;
  amount_cents: number | null;
  receipt_date: string | null;
  ai_confidence: number | null;
  status: TransactionStatus;
  bank_transaction_id: string | null;
  chase_reminder_count: number;
  created_at: string;
}

// =============================================================
// API RESPONSE TYPES
// =============================================================

/** Hydrated bank transaction row returned by GET /api/bank-feed */
export interface BankFeedRow {
  id: string;
  transaction_date: string;
  description: string;
  amount_cents: number;
  status: TransactionStatus;
  ai_confidence: number | null;
  ai_reasoning: string | null;
  match_type: 'VENDOR_PATTERN' | 'BILL_PAYMENT' | 'RECEIPT' | 'NONE' | null;
  match_confidence: number | null;
  matched_bill_id: string | null;
  matched_receipt_id: string | null;
  location: { id: string; name: string; short_code: string } | null;
  ai_account: { id: string; account_number: string; name: string; account_type?: AccountType } | null;
  ai_vendor: { id: string; name: string; display_name: string | null } | null;
  final_account: { id: string; account_number: string; name: string; account_type?: AccountType } | null;
  final_job: { id: string; job_number: string; name: string } | null;
  matched_bill: { id: string; bill_number: string | null } | null;
}

export interface BankFeedStatusCounts {
  count: number;
  amount_cents: number;
}

export interface BankFeedMetrics {
  total_today: number;
  reviewed_today: number;
  auto_approved_today: number;
  avg_confidence: number;
}

export interface BankFeedResponse {
  data: BankFeedRow[];
  counts: {
    all: BankFeedStatusCounts;
    PENDING: BankFeedStatusCounts;
    CATEGORIZED: BankFeedStatusCounts;
    FLAGGED: BankFeedStatusCounts;
  };
  metrics: BankFeedMetrics;
  pagination: {
    page: number;
    per_page: number;
    total: number;
    total_pages: number;
  };
}

// =============================================================
// JOBS & AR
// =============================================================

export interface Job {
  id: string;
  org_id: string;
  location_id: string;
  job_number: string;
  name: string;
  customer_name: string | null;
  job_type: string | null;
  status: string;
  contract_amount_cents: number | null;
  estimated_cost_cents: number | null;
  actual_cost_cents: number;
  billed_to_date_cents: number;
  pct_complete: number | null;
  created_at: string;
}

/** Lightweight job record returned by /api/jobs/search */
export interface JobSearchResult {
  id: string;
  job_number: string;
  name: string;
  customer_name: string | null;
  job_type: string | null;
  status: string;
}

export interface Invoice {
  id: string;
  org_id: string;
  location_id: string;
  customer_id: string;
  job_id: string | null;
  invoice_number: string;
  invoice_date: string;
  due_date: string;
  total_cents: number;
  amount_paid_cents: number;
  balance_cents: number;
  status: string;
  is_progress_bill: boolean;
  created_at: string;
}

export interface Customer {
  id: string;
  org_id: string;
  name: string;
  email: string | null;
  payment_terms_days: number;
  is_active: boolean;
  created_at: string;
}

// =============================================================
// WORKFORCE
// =============================================================

export interface Employee {
  id: string;
  org_id: string;
  clerk_user_id: string | null;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  department_id: string | null;
  hourly_rate_cents: number | null;
  annual_salary_cents: number | null;
  // Suite Core (Session 14): payroll account mapping into Books COA.
  payroll_account_id: string | null;
  is_active: boolean;
  created_at: string;
}

// =============================================================
// ITEMS (Suite Core — thin canonical; deep fields reserved for Inventory)
// =============================================================

export type ItemType = 'INVENTORY' | 'NON_INVENTORY' | 'SERVICE' | 'LABOR' | 'OTHER';

export interface Item {
  id: string;
  org_id: string;
  sku: string;
  name: string;
  item_type: ItemType;
  unit_of_measure: string | null;
  default_unit_cost_cents: number | null;
  // Books-owned columns co-located on the core table:
  income_account_id: string | null;
  cogs_account_id: string | null;
  is_active: boolean;
  created_at: string;
}
