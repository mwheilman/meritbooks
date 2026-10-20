/**
 * Dealer Pack — shared vocabulary (FPB-dealer-pack.md, slice D1).
 *
 * Every literal union below mirrors a CHECK constraint in migration 169 exactly, so
 * the schema-contract guard test can see that every value the code writes is one the
 * database accepts. Keep them in lock-step with the migration.
 */

export type DeptRole = 'WG_NEW' | 'WG_USED' | 'PARTS' | 'SERVICE' | 'RENTAL' | 'ADMIN';
export const DEPT_ROLES: readonly DeptRole[] = ['WG_NEW', 'WG_USED', 'PARTS', 'SERVICE', 'RENTAL', 'ADMIN'];

export type UnitCondition = 'NEW' | 'USED' | 'DEMO' | 'RENTAL';
export type UnitStatus =
  | 'ON_ORDER'
  | 'IN_TRANSIT'
  | 'IN_STOCK'
  | 'SOLD'
  | 'DELIVERED'
  | 'RENTAL'
  | 'RETURNED'
  | 'WRITTEN_OFF'
  | 'VOID';
/** Statuses whose cost is still carried in inventory (FPB §4.3 tie-out). */
export const CARRIED_UNIT_STATUSES: readonly UnitStatus[] = ['ON_ORDER', 'IN_TRANSIT', 'IN_STOCK', 'RENTAL'];

export type InventoryRole = 'WHOLE_GOODS_INVENTORY' | 'USED_WHOLE_GOODS_INVENTORY' | 'RENTAL_INVENTORY';
export type UnitSource = 'DMS' | 'LENDER' | 'MANUAL' | 'TRADE_IN' | 'OPENING';

export type CostType =
  | 'BASE_INVOICE'
  | 'FREIGHT'
  | 'SETUP_PDI'
  | 'ACCESSORY'
  | 'RECON'
  | 'OTHER'
  | 'REBATE_REDUCTION'
  | 'WRITE_DOWN';
export type CostSourceType = 'FLOOR_PLAN_NOTE' | 'BILL_LINE' | 'INTERNAL_RO' | 'INCENTIVE' | 'JE' | 'TRADE_IN' | 'OPENING';
export type RowStatus = 'PROPOSED' | 'POSTED' | 'VOID';

export type LineStatus = 'ACTIVE' | 'SUSPENDED' | 'CREDIT_HOLD' | 'CLOSED';
export type RateType = 'FIXED' | 'INDEX_PLUS';
export type DayCount = 'ACT_365' | 'ACT_360';
export type PayoffTerms = 'PAY_AS_SOLD' | 'DAYS_AFTER_SALE';
export type ProgramStatus = 'DRAFT' | 'ACTIVE' | 'RETIRED';

export type CollateralType = 'WHOLE_GOOD' | 'OPEN_ACCOUNT' | 'OTHER';
export type NoteStatus = 'OPEN' | 'SOLD_UNPAID' | 'PAID_OFF' | 'IN_DEFAULT' | 'RETURNED' | 'VOID';
export const LIVE_NOTE_STATUSES: readonly NoteStatus[] = ['OPEN', 'SOLD_UNPAID', 'IN_DEFAULT'];
export type SoldDetectedBy = 'BOOKS_SALE' | 'DMS_DEAL' | 'WARRANTY_REG' | 'LENDER_AUDIT';

export type FloorTxnType =
  | 'FLOOR'
  | 'OPENING'
  | 'CURTAILMENT'
  | 'PAYOFF'
  | 'INTEREST_ACCRUAL'
  | 'INTEREST_BILLED'
  | 'INTEREST_PAID'
  | 'FEE'
  | 'ADJUSTMENT'
  | 'REVERSAL';
export type CurtailmentStatus = 'DUE' | 'PAID' | 'WAIVED' | 'MISSED';

export type StatementKind = 'STATEMENT' | 'AUDIT' | 'PAYOFF_QUOTE';
export type StatementStatus = 'IMPORTED' | 'MATCHING' | 'PREPARED' | 'APPROVED';
export type StatementMatchStatus = 'UNMATCHED' | 'MATCHED' | 'VARIANCE' | 'LENDER_ONLY' | 'BOOKS_ONLY' | 'RESOLVED';
export type StatementMatchMethod = 'INVOICE_NUMBER' | 'SERIAL' | 'MODEL_AMOUNT' | 'BOOKS_ONLY';

export type TradeValuationPolicy = 'LOWER_OF_ACV_AND_ALLOWANCE' | 'ACV' | 'ALLOWANCE';
export type TradeStatus = 'DRAFT' | 'APPROVED' | 'POSTED' | 'VOID';
export type LienStatus = 'NONE' | 'OWED' | 'PROPOSED' | 'PAID';

export type SalePostingMode = 'DEAL' | 'BOOKS_INVOICE';
export type SaleSource = 'BOOKS' | 'DMS';

export type WarrantyRecognition = 'ON_RO_CLOSE' | 'ON_SUBMIT';
export type WarrantyStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'PARTIAL'
  | 'PAID'
  | 'REJECTED'
  | 'RESUBMITTED'
  | 'WRITTEN_OFF'
  | 'DEBITED'
  | 'VOID';

export type ProgramType =
  | 'RETAIL_REBATE'
  | 'DEALER_REBATE'
  | 'VOLUME_BONUS'
  | 'HOLDBACK'
  | 'CO_OP'
  | 'SPIFF'
  | 'INTEREST_SUBSIDY'
  | 'FLOOR_PLAN_SUPPORT'
  | 'DEMO_SUPPORT'
  | 'OTHER';
export type IncentiveTreatment = 'TRANSACTION_PRICE' | 'COST_REDUCTION' | 'EXPENSE_REIMBURSEMENT' | 'PASS_THROUGH';
export type OemProgramStatus = 'DRAFT' | 'ACTIVE' | 'EXPIRED';
export type IncentiveStatus = 'ACCRUED' | 'SUBMITTED' | 'PARTIAL' | 'PAID' | 'REJECTED' | 'WRITTEN_OFF' | 'VOID';

export type OemLineType = 'WARRANTY_CREDIT' | 'INCENTIVE_CREDIT' | 'DEBIT' | 'PARTS_INVOICE' | 'OTHER';
export type OemMatchStatus = 'UNMATCHED' | 'PROPOSED' | 'MATCHED' | 'SETTLED' | 'IGNORED';
export type OemStatementStatus = 'IMPORTED' | 'MATCHING' | 'SETTLED';

export type ClaimKind = 'WARRANTY' | 'INCENTIVE';
export type ClaimEventType =
  | 'RECOGNIZED'
  | 'ACCRUED'
  | 'SUBMITTED'
  | 'RESUBMITTED'
  | 'CREDIT_APPLIED'
  | 'CASH_RECEIVED'
  | 'SHORT_PAY_ACCEPTED'
  | 'REJECTED'
  | 'WRITTEN_OFF'
  | 'DEBITED';

/** How the manufacturer pays a claim: a credit on its statement (AP) or cash. */
export type OemSettlementMethod = 'STATEMENT_CREDIT' | 'CASH';
export type CostReductionInStock = 'REDUCE_UNIT_COST' | 'REDUCE_COGS';

export type ImportFileKind =
  | 'UNITS'
  | 'DEALS'
  | 'WARRANTY'
  | 'LENDER_STATEMENT'
  | 'LENDER_AUDIT'
  | 'OEM_STATEMENT'
  | 'PROGRAMS'
  | 'OPENING';
export type ImportStatus = 'UPLOADED' | 'VALIDATED' | 'PROPOSED' | 'POSTED' | 'UNDONE' | 'FAILED';

/** The per-client policy row (dealer_pack_settings), numbers coerced. */
export interface DealerSettings {
  id: string | null;
  org_id: string;
  location_id: string;
  enabled: boolean;
  dms_system: string | null;
  trade_valuation_policy: TradeValuationPolicy;
  warranty_recognition: WarrantyRecognition;
  warranty_relieve_parts_inventory: boolean;
  capitalize_setup_labor: boolean;
  cost_reduction_in_stock: CostReductionInStock;
  oem_settlement_default: OemSettlementMethod;
  sot_grace_days: number;
  aging_buckets: number[];
  term_warning_days: number;
  interest_tolerance_cents: number;
  interest_tolerance_bps: number;
  statement_tolerance_cents: number;
  auto_match_min_confidence_bps: number;
  curtailment_warn_days: number;
  warranty_deadline_warn_days: number;
  warranty_submitted_aging_days: number;
  incentive_deadline_warn_days: number;
  incentive_submitted_aging_days: number;
  lien_unpaid_days: number;
  over_allowance_warn_bps: number;
  line_utilization_warn_bps: number;
  trade_acv_approval_threshold_cents: number;
}

/** Defaults identical to the migration's column defaults (used before a row exists). */
export function defaultSettings(orgId: string, locationId: string): DealerSettings {
  return {
    id: null,
    org_id: orgId,
    location_id: locationId,
    enabled: false,
    dms_system: null,
    trade_valuation_policy: 'LOWER_OF_ACV_AND_ALLOWANCE',
    warranty_recognition: 'ON_SUBMIT',
    warranty_relieve_parts_inventory: true,
    capitalize_setup_labor: true,
    cost_reduction_in_stock: 'REDUCE_UNIT_COST',
    oem_settlement_default: 'STATEMENT_CREDIT',
    sot_grace_days: 2,
    aging_buckets: [90, 180, 270, 365],
    term_warning_days: 60,
    interest_tolerance_cents: 2500,
    interest_tolerance_bps: 200,
    statement_tolerance_cents: 100,
    auto_match_min_confidence_bps: 9500,
    curtailment_warn_days: 7,
    warranty_deadline_warn_days: 5,
    warranty_submitted_aging_days: 45,
    incentive_deadline_warn_days: 10,
    incentive_submitted_aging_days: 60,
    lien_unpaid_days: 10,
    over_allowance_warn_bps: 2000,
    line_utilization_warn_bps: 9000,
    trade_acv_approval_threshold_cents: 0,
  };
}

/** Thrown by pure engines on an invalid business request (never a guess). */
export class DealerEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DealerEngineError';
  }
}
