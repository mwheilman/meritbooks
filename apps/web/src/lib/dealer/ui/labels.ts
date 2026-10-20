/**
 * Dealer Pack (D2) — plain-English labels for every code the D1 API returns.
 *
 * Pure and client-safe. Every screen renders these instead of the raw CHECK
 * literals (FPB §10.1 AC17 + CLAUDE.md "plain-English copy, no internal codes").
 * Each map is keyed by the exact literal union in lib/dealer/types.ts so a new
 * literal added in D1 fails the type-check here until it gets a label.
 */

import type {
  ClaimEventType,
  CollateralType,
  CostReductionInStock,
  CostSourceType,
  CostType,
  CurtailmentStatus,
  DayCount,
  DeptRole,
  FloorTxnType,
  ImportFileKind,
  ImportStatus,
  IncentiveStatus,
  IncentiveTreatment,
  LienStatus,
  LineStatus,
  NoteStatus,
  OemLineType,
  OemMatchStatus,
  OemProgramStatus,
  OemSettlementMethod,
  OemStatementStatus,
  PayoffTerms,
  ProgramStatus,
  ProgramType,
  RateType,
  RowStatus,
  SaleSource,
  SoldDetectedBy,
  StatementKind,
  StatementMatchStatus,
  StatementStatus,
  TradeStatus,
  TradeValuationPolicy,
  UnitCondition,
  UnitStatus,
  WarrantyRecognition,
  WarrantyStatus,
} from '../types';

/** Badge tone — mirrors components/ui/status-badge variants. */
export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'ai';

export interface Labelled {
  label: string;
  tone: Tone;
  /** One-line plain-English explanation (tooltips, legends). */
  hint?: string;
}

export const UNIT_STATUS: Record<UnitStatus, Labelled> = {
  ON_ORDER: { label: 'On order', tone: 'neutral' },
  IN_TRANSIT: { label: 'In transit', tone: 'info' },
  IN_STOCK: { label: 'In stock', tone: 'success' },
  SOLD: { label: 'Sold', tone: 'info' },
  DELIVERED: { label: 'Delivered', tone: 'neutral' },
  RENTAL: { label: 'Rental fleet', tone: 'info' },
  RETURNED: { label: 'Returned to manufacturer', tone: 'neutral' },
  WRITTEN_OFF: { label: 'Written off', tone: 'danger' },
  VOID: { label: 'Voided', tone: 'neutral' },
};

export const UNIT_CONDITION: Record<UnitCondition, Labelled> = {
  NEW: { label: 'New', tone: 'success' },
  USED: { label: 'Used', tone: 'info' },
  DEMO: { label: 'Demo', tone: 'warning' },
  RENTAL: { label: 'Rental', tone: 'info' },
};

export const COST_TYPE: Record<CostType, Labelled> = {
  BASE_INVOICE: { label: 'Manufacturer invoice', tone: 'neutral' },
  FREIGHT: { label: 'Freight', tone: 'neutral' },
  SETUP_PDI: { label: 'Setup / pre-delivery', tone: 'neutral' },
  ACCESSORY: { label: 'Accessory', tone: 'neutral' },
  RECON: { label: 'Reconditioning', tone: 'neutral' },
  OTHER: { label: 'Other cost', tone: 'neutral' },
  REBATE_REDUCTION: { label: 'Manufacturer rebate (reduces cost)', tone: 'success' },
  WRITE_DOWN: { label: 'Write-down', tone: 'danger' },
};

export const COST_SOURCE: Record<CostSourceType, string> = {
  FLOOR_PLAN_NOTE: 'Floor-plan note',
  BILL_LINE: 'Vendor bill',
  INTERNAL_RO: 'Internal repair order',
  INCENTIVE: 'Manufacturer incentive',
  JE: 'Journal entry',
  TRADE_IN: 'Trade-in',
  OPENING: 'Opening balance',
};

export const ROW_STATUS: Record<RowStatus, Labelled> = {
  PROPOSED: { label: 'Awaiting approval', tone: 'warning' },
  POSTED: { label: 'Posted', tone: 'success' },
  VOID: { label: 'Voided', tone: 'neutral' },
};

export const LINE_STATUS: Record<LineStatus, Labelled> = {
  ACTIVE: { label: 'Active', tone: 'success' },
  SUSPENDED: { label: 'Suspended', tone: 'warning' },
  CREDIT_HOLD: { label: 'Credit hold', tone: 'danger', hint: 'The lender is not releasing new orders until the account is current.' },
  CLOSED: { label: 'Closed', tone: 'neutral' },
};

export const PROGRAM_STATUS: Record<ProgramStatus, Labelled> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  ACTIVE: { label: 'Active', tone: 'success' },
  RETIRED: { label: 'Retired', tone: 'neutral' },
};

export const RATE_TYPE: Record<RateType, string> = { FIXED: 'Fixed rate', INDEX_PLUS: 'Index plus spread' };
export const DAY_COUNT: Record<DayCount, string> = { ACT_365: 'Actual / 365', ACT_360: 'Actual / 360' };
export const PAYOFF_TERMS: Record<PayoffTerms, string> = {
  PAY_AS_SOLD: 'Pay off when sold',
  DAYS_AFTER_SALE: 'Pay off a set number of days after sale',
};

export const COLLATERAL: Record<CollateralType, string> = {
  WHOLE_GOOD: 'Serialized unit',
  OPEN_ACCOUNT: 'Open account (parts)',
  OTHER: 'Other',
};

export const NOTE_STATUS: Record<NoteStatus, Labelled> = {
  OPEN: { label: 'Open', tone: 'info' },
  SOLD_UNPAID: { label: 'Sold — payoff owed', tone: 'danger', hint: 'The unit is sold; the lender must be paid off.' },
  PAID_OFF: { label: 'Paid off', tone: 'success' },
  IN_DEFAULT: { label: 'In default', tone: 'danger' },
  RETURNED: { label: 'Returned', tone: 'neutral' },
  VOID: { label: 'Voided', tone: 'neutral' },
};

export const SOLD_DETECTED_BY: Record<SoldDetectedBy, string> = {
  BOOKS_SALE: 'Sale recorded in Books',
  DMS_DEAL: 'Deal in the dealer system',
  WARRANTY_REG: 'Manufacturer warranty registration',
  LENDER_AUDIT: 'Lender floor check',
};

export const TXN_TYPE: Record<FloorTxnType, string> = {
  FLOOR: 'Unit floored',
  OPENING: 'Opening balance',
  CURTAILMENT: 'Curtailment paid',
  PAYOFF: 'Payoff',
  INTEREST_ACCRUAL: 'Interest accrued',
  INTEREST_BILLED: 'Interest billed by lender',
  INTEREST_PAID: 'Interest paid',
  FEE: 'Lender fee',
  ADJUSTMENT: 'Adjustment',
  REVERSAL: 'Reversal',
};

export const CURTAILMENT_STATUS: Record<CurtailmentStatus, Labelled> = {
  DUE: { label: 'Due', tone: 'warning' },
  PAID: { label: 'Paid', tone: 'success' },
  WAIVED: { label: 'Waived', tone: 'neutral' },
  MISSED: { label: 'Missed', tone: 'danger' },
};

export const STATEMENT_KIND: Record<StatementKind, string> = {
  STATEMENT: 'Monthly statement',
  AUDIT: 'Floor check (audit)',
  PAYOFF_QUOTE: 'Payoff quote',
};

export const STATEMENT_STATUS: Record<StatementStatus, Labelled> = {
  IMPORTED: { label: 'Imported', tone: 'neutral' },
  MATCHING: { label: 'Matching', tone: 'info' },
  PREPARED: { label: 'Prepared — awaiting sign-off', tone: 'warning' },
  APPROVED: { label: 'Signed off', tone: 'success' },
};

export const STATEMENT_MATCH: Record<StatementMatchStatus, Labelled> = {
  UNMATCHED: { label: 'Not matched yet', tone: 'neutral' },
  MATCHED: { label: 'Matched', tone: 'success' },
  VARIANCE: { label: 'Balance differs', tone: 'warning' },
  LENDER_ONLY: { label: 'Lender only', tone: 'danger', hint: 'The lender shows a note Books does not have.' },
  BOOKS_ONLY: { label: 'Books only', tone: 'danger', hint: 'Books shows a note the lender does not list.' },
  RESOLVED: { label: 'Resolved', tone: 'success' },
};

export const MATCH_METHOD: Record<string, string> = {
  INVOICE_NUMBER: 'Lender invoice #',
  SERIAL: 'Serial number',
  MODEL_AMOUNT: 'Model + amount',
  BOOKS_ONLY: 'Books only',
  CLAIM_NUMBER: 'Exact claim #',
  CLAIM_NUMBER_SHORT: 'Claim # (short-paid)',
  SERIAL_AMOUNT: 'Serial + amount',
};

export const TRADE_POLICY: Record<TradeValuationPolicy, Labelled> = {
  LOWER_OF_ACV_AND_ALLOWANCE: {
    label: 'Lower of appraised value and trade allowance',
    tone: 'neutral',
    hint: 'The used unit goes on the books at whichever is lower. Any over-allowance reduces the new unit’s gross; an under-allowance is not booked as a gain. (Default)',
  },
  ACV: {
    label: 'Appraised value (actual cash value)',
    tone: 'neutral',
    hint: 'The used unit goes on the books at its appraised value; an under-allowance is credited to the trade-in over-allowance account.',
  },
  ALLOWANCE: {
    label: 'Trade allowance',
    tone: 'neutral',
    hint: 'The used unit goes on the books at the allowance given to the customer.',
  },
};

export const TRADE_STATUS: Record<TradeStatus, Labelled> = {
  DRAFT: { label: 'Needs appraisal approval', tone: 'warning' },
  APPROVED: { label: 'Appraisal approved', tone: 'info' },
  POSTED: { label: 'Posted', tone: 'success' },
  VOID: { label: 'Voided', tone: 'neutral' },
};

export const LIEN_STATUS: Record<LienStatus, Labelled> = {
  NONE: { label: 'No lien', tone: 'neutral' },
  OWED: { label: 'Lien payoff owed', tone: 'warning' },
  PROPOSED: { label: 'Payoff proposed', tone: 'info' },
  PAID: { label: 'Lien paid', tone: 'success' },
};

export const SALE_SOURCE: Record<SaleSource, string> = { BOOKS: 'Entered in Books', DMS: 'Imported from dealer system' };

export const WARRANTY_RECOGNITION: Record<WarrantyRecognition, Labelled> = {
  ON_SUBMIT: {
    label: 'When the claim is submitted to the manufacturer',
    tone: 'neutral',
    hint: 'The receivable and warranty sales are booked on submission. (Default)',
  },
  ON_RO_CLOSE: {
    label: 'When the repair order closes',
    tone: 'neutral',
    hint: 'The receivable is booked as soon as the warranty repair order is closed, before submission.',
  },
};

export const WARRANTY_STATUS: Record<WarrantyStatus, Labelled> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  SUBMITTED: { label: 'Submitted', tone: 'info' },
  PARTIAL: { label: 'Partly paid', tone: 'warning' },
  PAID: { label: 'Paid', tone: 'success' },
  REJECTED: { label: 'Rejected by manufacturer', tone: 'danger' },
  RESUBMITTED: { label: 'Resubmitted', tone: 'info' },
  WRITTEN_OFF: { label: 'Written off', tone: 'neutral' },
  DEBITED: { label: 'Charged back', tone: 'danger' },
  VOID: { label: 'Voided', tone: 'neutral' },
};

export const PROGRAM_TYPE: Record<ProgramType, string> = {
  RETAIL_REBATE: 'Retail (customer) rebate',
  DEALER_REBATE: 'Dealer rebate',
  VOLUME_BONUS: 'Volume / target bonus',
  HOLDBACK: 'Holdback',
  CO_OP: 'Co-op advertising',
  SPIFF: 'Salesperson spiff',
  INTEREST_SUBSIDY: 'Interest subsidy',
  FLOOR_PLAN_SUPPORT: 'Floor-plan support',
  DEMO_SUPPORT: 'Demo support',
  OTHER: 'Other program',
};

export const TREATMENT: Record<IncentiveTreatment, Labelled> = {
  TRANSACTION_PRICE: {
    label: 'Part of the sale price',
    tone: 'neutral',
    hint: 'The manufacturer pays part of the customer’s price — booked as a receivable inside the sale.',
  },
  COST_REDUCTION: {
    label: 'Reduces unit cost',
    tone: 'neutral',
    hint: 'Money from the manufacturer that lowers what the unit cost (or cost of sales once sold).',
  },
  EXPENSE_REIMBURSEMENT: {
    label: 'Reimburses an expense',
    tone: 'neutral',
    hint: 'Pays back a specific cost the dealer already paid (co-op ads, floor-plan interest).',
  },
  PASS_THROUGH: {
    label: 'Passed through to staff',
    tone: 'neutral',
    hint: 'Not dealer income — owed on to salespeople through commissions or payroll.',
  },
};

export const OEM_PROGRAM_STATUS: Record<OemProgramStatus, Labelled> = {
  DRAFT: { label: 'Draft — needs approval', tone: 'warning' },
  ACTIVE: { label: 'Active', tone: 'success' },
  EXPIRED: { label: 'Expired', tone: 'neutral' },
};

export const INCENTIVE_STATUS: Record<IncentiveStatus, Labelled> = {
  ACCRUED: { label: 'Earned — not claimed', tone: 'warning' },
  SUBMITTED: { label: 'Claimed', tone: 'info' },
  PARTIAL: { label: 'Partly paid', tone: 'warning' },
  PAID: { label: 'Paid', tone: 'success' },
  REJECTED: { label: 'Rejected by manufacturer', tone: 'danger' },
  WRITTEN_OFF: { label: 'Written off', tone: 'neutral' },
  VOID: { label: 'Voided', tone: 'neutral' },
};

export const OEM_LINE_TYPE: Record<OemLineType, string> = {
  WARRANTY_CREDIT: 'Warranty credit',
  INCENTIVE_CREDIT: 'Incentive credit',
  DEBIT: 'Debit / chargeback',
  PARTS_INVOICE: 'Parts invoice',
  OTHER: 'Other',
};

export const OEM_MATCH_STATUS: Record<OemMatchStatus, Labelled> = {
  UNMATCHED: { label: 'Not matched', tone: 'neutral' },
  PROPOSED: { label: 'Suggested match', tone: 'ai' },
  MATCHED: { label: 'Matched', tone: 'info' },
  SETTLED: { label: 'Applied', tone: 'success' },
  IGNORED: { label: 'Ignored', tone: 'neutral' },
};

export const OEM_STATEMENT_STATUS: Record<OemStatementStatus, Labelled> = {
  IMPORTED: { label: 'Imported', tone: 'neutral' },
  MATCHING: { label: 'Matching', tone: 'info' },
  SETTLED: { label: 'All lines applied', tone: 'success' },
};

export const SETTLEMENT_METHOD: Record<OemSettlementMethod, Labelled> = {
  STATEMENT_CREDIT: {
    label: 'Credit on the manufacturer’s statement',
    tone: 'neutral',
    hint: 'The manufacturer pays by crediting the dealer’s parts account (reduces what the dealer owes them). (Default)',
  },
  CASH: { label: 'Check or ACH', tone: 'neutral', hint: 'The manufacturer pays cash into the operating bank.' },
};

export const COST_REDUCTION_POLICY: Record<CostReductionInStock, Labelled> = {
  REDUCE_UNIT_COST: {
    label: 'Lower the unit’s cost while it is in stock',
    tone: 'neutral',
    hint: 'A dealer rebate on an unsold unit reduces that unit’s inventory cost. (Default)',
  },
  REDUCE_COGS: {
    label: 'Credit cost of sales right away',
    tone: 'neutral',
    hint: 'A dealer rebate goes straight to cost of sales even if the unit is not sold yet.',
  },
};

export const CLAIM_EVENT: Record<ClaimEventType, string> = {
  RECOGNIZED: 'Receivable booked',
  ACCRUED: 'Incentive earned',
  SUBMITTED: 'Submitted',
  RESUBMITTED: 'Resubmitted',
  CREDIT_APPLIED: 'Statement credit applied',
  CASH_RECEIVED: 'Cash received',
  SHORT_PAY_ACCEPTED: 'Short-pay accepted',
  REJECTED: 'Rejected',
  WRITTEN_OFF: 'Written off',
  DEBITED: 'Charged back',
};

export const FILE_KIND: Record<ImportFileKind, Labelled> = {
  UNITS: { label: 'Units in stock', tone: 'neutral', hint: 'Serial, model, cost and received date from the dealer system.' },
  DEALS: { label: 'Unit sales (deals)', tone: 'neutral', hint: 'Deal recaps with trade-ins, rebates and deposits.' },
  WARRANTY: { label: 'Warranty claims', tone: 'neutral', hint: 'The warranty claim register.' },
  LENDER_STATEMENT: { label: 'Lender statement', tone: 'neutral' },
  LENDER_AUDIT: { label: 'Lender floor check', tone: 'neutral' },
  OEM_STATEMENT: { label: 'Manufacturer statement', tone: 'neutral' },
  PROGRAMS: { label: 'Manufacturer programs', tone: 'neutral' },
  OPENING: { label: 'Opening balances (go-live)', tone: 'neutral' },
};

export const IMPORT_STATUS: Record<ImportStatus, Labelled> = {
  UPLOADED: { label: 'Uploaded', tone: 'neutral' },
  VALIDATED: { label: 'Checked', tone: 'info' },
  PROPOSED: { label: 'Awaiting approval', tone: 'warning' },
  POSTED: { label: 'Posted', tone: 'success' },
  UNDONE: { label: 'Undone', tone: 'neutral' },
  FAILED: { label: 'Failed', tone: 'danger' },
};

export const DEPT_ROLE: Record<DeptRole, Labelled> = {
  WG_NEW: { label: 'New equipment sales', tone: 'neutral', hint: 'New whole goods.' },
  WG_USED: { label: 'Used equipment sales', tone: 'neutral', hint: 'Used whole goods and trade-ins.' },
  PARTS: { label: 'Parts', tone: 'neutral' },
  SERVICE: { label: 'Service', tone: 'neutral' },
  RENTAL: { label: 'Rental', tone: 'neutral' },
  ADMIN: { label: 'Administration', tone: 'neutral', hint: 'General and administrative / fixed overhead.' },
};

/** Safe lookup: unknown codes degrade to a title-cased string, never a crash. */
export function labelOf<K extends string>(map: Partial<Record<K, Labelled | string>>, code: string | null | undefined): string {
  if (!code) return '—';
  const v = map[code as K];
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') return v.label;
  return humanize(code);
}

export function toneOf<K extends string>(map: Partial<Record<K, Labelled>>, code: string | null | undefined): Tone {
  if (!code) return 'neutral';
  return map[code as K]?.tone ?? 'neutral';
}

export function hintOf<K extends string>(map: Partial<Record<K, Labelled>>, code: string | null | undefined): string | undefined {
  if (!code) return undefined;
  return map[code as K]?.hint;
}

/** "SOLD_UNPAID" → "Sold unpaid" (fallback only — every known code has a label above). */
export function humanize(code: string): string {
  const s = code.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
