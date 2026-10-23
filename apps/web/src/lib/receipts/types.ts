/**
 * Receipt capture, matching and chase (migration 181, FPB-workforce-app §15) — shared
 * types. Literals mirror the migration's CHECK constraints exactly (schema-contract).
 */

export const CHARGE_STATES = [
  'needed', 'requested', 'matched', 'not_required', 'below_threshold', 'chase_off', 'no_cardholder', 'opted_out',
] as const;
export type ChargeState = (typeof CHARGE_STATES)[number];

/** States the bookkeeper still has to see through (a receipt is owed or someone must decide). */
export const OUTSTANDING_STATES: readonly ChargeState[] = ['needed', 'requested', 'chase_off', 'no_cardholder', 'opted_out'];

export const MATCH_STATUSES = ['unmatched', 'suggested', 'matched', 'not_required'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const MATCH_METHODS = ['auto', 'confirmed', 'manual', 'request'] as const;
export type MatchMethod = (typeof MATCH_METHODS)[number];

export const EXTRACTION_STATUSES = ['pending', 'done', 'failed', 'skipped'] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

export const HOLDER_TYPES = ['member', 'employee', 'external'] as const;
export type HolderType = (typeof HOLDER_TYPES)[number];

export const OPT_OUT_STATUSES = ['none', 'pending', 'approved', 'rejected'] as const;
export type OptOutStatus = (typeof OPT_OUT_STATUSES)[number];

export type EscalateTo = 'manager' | 'bookkeeper' | 'none';

/** receipts.source (migration 005 CHECK). Merit Workforce captures are MOBILE_CAPTURE. */
export type ReceiptSource = 'MOBILE_CAPTURE' | 'EMAIL' | 'MANUAL_UPLOAD';

/** Receipt flags a person should look at. */
export type ReceiptFlag = 'amount_differs' | 'date_differs' | 'memo_missing' | 'duplicate_suspect';

export interface CardAssignmentRow {
  id: string;
  org_id: string;
  location_id: string;
  bank_account_id: string | null;
  card_last4: string | null;
  card_label: string | null;
  holder_type: HolderType;
  membership_id: string | null;
  employee_id: string | null;
  holder_name: string;
  holder_email: string | null;
  holder_phone: string | null;
  holder_timezone: string | null;
  manager_membership_id: string | null;
  active: boolean;
  starts_on: string | null;
  ends_on: string | null;
  chase_opt_out: boolean;
  opt_out_status: OptOutStatus;
  opt_out_reason: string | null;
  opt_out_requested_by: string | null;
  opt_out_requested_at: string | null;
  opt_out_decided_by: string | null;
  opt_out_decided_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChargeStateRow {
  id: string;
  org_id: string;
  location_id: string;
  bank_transaction_id: string;
  bank_account_id: string | null;
  card_assignment_id: string | null;
  holder_override: boolean;
  charge_date: string;
  amount_cents: number;
  merchant: string | null;
  status: ChargeState;
  request_id: string | null;
  receipt_id: string | null;
  chase_count: number;
  reason: string | null;
  decided_by: string | null;
  decided_at: string | null;
  first_seen_at: string;
  updated_at: string;
}

/** The bank_transactions columns the chase reads (migration 005 + later). */
export interface ChargeTxn {
  id: string;
  org_id: string;
  location_id: string;
  bank_account_id: string;
  transaction_date: string;
  description: string;
  amount_cents: number;
  matched_receipt_id: string | null;
  matched_bill_id: string | null;
}

export interface CardAccount {
  id: string;
  location_id: string;
  account_type: string;
  account_mask: string | null;
  account_name: string;
  is_active: boolean;
}

/** public.receipts columns the matcher / capture code reads. */
export interface ReceiptRow {
  id: string;
  org_id: string;
  location_id: string;
  source: ReceiptSource;
  vendor_name: string | null;
  amount_cents: number | null;
  receipt_date: string | null;
  status: string;
  bank_transaction_id: string | null;
  card_assignment_id: string | null;
  document_id: string | null;
  memo: string | null;
  job_id: string | null;
  match_status: MatchStatus;
  match_score: number | null;
  match_candidate_txn_id: string | null;
  match_method: MatchMethod | null;
  matched_at: string | null;
  extraction_status: ExtractionStatus;
  content_sha256: string | null;
  ai_extracted_data: Record<string, unknown> | null;
  chase_reminder_count: number;
  flags: string[];
  submitted_at: string;
  submitted_by_user: string | null;
}

/** Plain-English labels for the desk and the Workforce app. */
export const CHARGE_STATE_LABEL: Record<ChargeState, string> = {
  needed: 'Receipt needed',
  requested: 'Asked',
  matched: 'Receipt in',
  not_required: 'Not required',
  below_threshold: 'Under the limit',
  chase_off: 'Chase off',
  no_cardholder: 'No cardholder',
  opted_out: 'Cardholder opted out',
};

export const SYSTEM_ACTOR = 'system:receipts';
