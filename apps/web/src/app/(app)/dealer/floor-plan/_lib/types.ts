/**
 * Client-side row shapes for the floor-plan and lender-statement screens (slice D2-B).
 * Snake_case, cents as numbers — they mirror the D1 list rows (`select *`), whose
 * columns are verified against migration 169 (Rule 11). Pure types only.
 */

import type {
  CollateralType,
  CurtailmentStatus,
  DayCount,
  FloorTxnType,
  LineStatus,
  NoteStatus,
  PayoffTerms,
  ProgramStatus,
  RateType,
  RowStatus,
  SoldDetectedBy,
  StatementKind,
  StatementMatchMethod,
  StatementMatchStatus,
  StatementStatus,
} from '@/lib/dealer/types';

/** floor_plan_lines */
export interface FpLine {
  id: string;
  location_id: string;
  lender_vendor_id: string;
  name: string;
  credit_limit_cents: number;
  liability_account_id: string | null;
  interest_due_day: number | null;
  scheduled_payment_day: number | null;
  statement_day: number | null;
  sau_codes: string[];
  debt_instrument_id: string | null;
  status: LineStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** floor_plan_programs */
export interface FpProgram {
  id: string;
  location_id: string;
  line_id: string;
  oem_vendor_id: string | null;
  name: string;
  free_floor_days: number;
  rate_type: RateType;
  rate_bps: number;
  index_name: string | null;
  index_rate_bps: number | null;
  spread_bps: number | null;
  sau_penalty_rate_bps: number | null;
  day_count: DayCount;
  payoff_terms: PayoffTerms;
  payoff_days: number;
  max_term_days: number | null;
  curtail_demos: boolean;
  curtailment_schedule: unknown;
  effective_from: string;
  effective_to: string | null;
  status: ProgramStatus;
  created_at: string;
}

/** floor_plan_notes */
export interface FpNote {
  id: string;
  location_id: string;
  line_id: string;
  program_id: string | null;
  unit_id: string | null;
  collateral_type: CollateralType;
  lender_invoice_number: string;
  description: string | null;
  floored_date: string;
  original_principal_cents: number;
  principal_balance_cents: number;
  free_floor_end_date: string | null;
  maturity_date: string | null;
  scheduled_due_date: string | null;
  interest_accrued_through: string | null;
  status: NoteStatus;
  sold_date: string | null;
  payoff_due_date: string | null;
  paid_off_date: string | null;
  sold_detected_by: SoldDetectedBy | null;
  is_opening: boolean;
  import_batch_id: string | null;
  created_at: string;
}

/** floor_plan_transactions */
export interface FpTxn {
  id: string;
  line_id: string;
  note_id: string | null;
  txn_type: FloorTxnType;
  txn_date: string;
  period_end: string | null;
  principal_cents: number;
  interest_cents: number;
  accrual_cleared_cents: number;
  fee_cents: number;
  status: RowStatus;
  gl_entry_id: string | null;
  curtailment_id: string | null;
  memo: string | null;
  proposed_by: string | null;
  approved_by: string | null;
  released_by: string | null;
  posted_at: string | null;
  disposition: string | null;
  created_at: string;
}

/** floor_plan_curtailments */
export interface FpCurtailment {
  id: string;
  note_id: string;
  sequence: number;
  due_date: string;
  amount_cents: number;
  status: CurtailmentStatus;
  paid_txn_id: string | null;
  waived_by: string | null;
  waived_reason: string | null;
  created_at: string;
}

/** lender_statements */
export interface LenderStatement {
  id: string;
  line_id: string;
  kind: StatementKind;
  statement_date: string;
  document_id: string | null;
  import_batch_id: string | null;
  footer_principal_cents: number | null;
  footer_interest_cents: number | null;
  footer_fees_cents: number | null;
  footer_line_count: number | null;
  status: StatementStatus;
  prepared_by: string | null;
  prepared_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
}

/** lender_statement_lines */
export interface LenderStatementLine {
  id: string;
  statement_id: string;
  line_number: number | null;
  lender_invoice_number: string | null;
  serial_number: string | null;
  model: string | null;
  original_cents: number | null;
  current_cents: number | null;
  interest_cents: number | null;
  fees_cents: number | null;
  lender_code: string | null;
  disposition_date: string | null;
  days: number | null;
  matched_note_id: string | null;
  match_status: StatementMatchStatus;
  match_method: StatementMatchMethod | null;
  variance_cents: number;
  sau_flag: boolean;
  resolution: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
}

/** GET /api/dealer/note-refs — a note plus its unit's serial/model (slice-B read route). */
export interface NoteRef {
  id: string;
  line_id: string;
  program_id: string | null;
  unit_id: string | null;
  lender_invoice_number: string;
  status: NoteStatus;
  floored_date: string;
  original_principal_cents: number;
  principal_balance_cents: number;
  sold_date: string | null;
  payoff_due_date: string | null;
  serial_number: string | null;
  model: string | null;
}

/** Lane aggregate from GET /api/dealer/statement-detail. */
export interface LaneTotals {
  count: number;
  lenderCents: number;
  booksCents: number;
  absVarianceCents: number;
}

export interface StatementDetail {
  statement: LenderStatement;
  line: { id: string; name: string; lender_vendor_id: string; sau_codes: string[]; status: LineStatus } | null;
  lanes: Record<StatementMatchStatus, LaneTotals>;
  overToleranceCount: number;
  sauOpenNoteIds: Array<{ lineId: string; noteId: string }>;
  toleranceCents: number;
}
