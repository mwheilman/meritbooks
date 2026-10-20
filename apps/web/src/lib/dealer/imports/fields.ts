/**
 * Dealer imports — the TARGET FIELDS for every import kind (pure, client-safe).
 *
 * Each field has a stable key (the request field it feeds), a plain-English label, a
 * type, whether it is required, and GENERIC header synonyms used to auto-suggest a
 * column mapping. Synonyms are ordinary accounting / dealer words — never a vendor,
 * lender, manufacturer or dealer-system name (FPB AC18).
 */

import type { ImportFileKind } from '../types';

export type FieldType = 'text' | 'money' | 'signedMoney' | 'date' | 'int' | 'hours' | 'pct' | 'enum' | 'bool';

export interface EnumOption {
  value: string;
  label: string;
  synonyms?: readonly string[];
}

export interface TargetField {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  hint?: string;
  synonyms: readonly string[];
  options?: readonly EnumOption[];
  /** Text length cap (mirrors lib/validations/dealer.ts). */
  max?: number;
  /** Visual grouping in the mapping step. */
  group?: 'unit' | 'floor' | 'trade' | 'check';
}

const SERIAL: TargetField = {
  key: 'serialNumber', label: 'Serial number', type: 'text', required: true, max: 100,
  synonyms: ['serial', 'serial #', 'serial no', 'serial number', 'serial num', 'sn', 's n', 'unit serial', 'ser #', 'ser no'],
};

const CONDITION_OPTIONS: readonly EnumOption[] = [
  { value: 'NEW', label: 'New', synonyms: ['new', 'n'] },
  { value: 'USED', label: 'Used', synonyms: ['used', 'u', 'pre owned', 'preowned', 'pre-owned', 'trade'] },
  { value: 'DEMO', label: 'Demo', synonyms: ['demo', 'demonstrator', 'd'] },
  { value: 'RENTAL', label: 'Rental', synonyms: ['rental', 'rent', 'r', 'rental fleet'] },
];

const UNIT_STATUS_OPTIONS: readonly EnumOption[] = [
  { value: 'IN_STOCK', label: 'In stock', synonyms: ['in stock', 'stock', 'on hand', 'available', 'received', 'instock'] },
  { value: 'IN_TRANSIT', label: 'In transit', synonyms: ['in transit', 'transit', 'shipped', 'en route'] },
  { value: 'ON_ORDER', label: 'On order', synonyms: ['on order', 'ordered', 'order', 'po'] },
];

const UNIT_CORE: TargetField[] = [
  SERIAL,
  { key: 'stockNumber', label: 'Stock number', type: 'text', max: 100, group: 'unit', synonyms: ['stock', 'stock #', 'stock no', 'stock number', 'stk', 'stk #', 'stk no', 'unit #', 'unit no'] },
  { key: 'vinHin', label: 'VIN / HIN', type: 'text', max: 100, group: 'unit', synonyms: ['vin', 'hin', 'vin hin', 'vin/hin', 'pin', 'product id'] },
  { key: 'make', label: 'Make (manufacturer)', type: 'text', max: 200, group: 'unit', hint: 'Matched to a vendor in Books by name.', synonyms: ['make', 'manufacturer', 'mfr', 'mfg', 'brand', 'oem', 'maker'] },
  { key: 'model', label: 'Model', type: 'text', max: 200, group: 'unit', synonyms: ['model', 'model #', 'model no', 'model number', 'model name', 'model code'] },
  { key: 'modelYear', label: 'Model year', type: 'int', group: 'unit', synonyms: ['year', 'model year', 'yr', 'my', 'model yr'] },
  { key: 'description', label: 'Description', type: 'text', max: 1000, group: 'unit', synonyms: ['description', 'desc', 'unit description', 'item description'] },
  { key: 'condition', label: 'New / used', type: 'enum', group: 'unit', options: CONDITION_OPTIONS, hint: 'Blank uses the default you chose.', synonyms: ['condition', 'new used', 'n u', 'new/used', 'n/u', 'cond', 'unit type', 'inventory type'] },
  { key: 'status', label: 'Stock status', type: 'enum', group: 'unit', options: UNIT_STATUS_OPTIONS, hint: 'Blank means in stock.', synonyms: ['status', 'stock status', 'unit status', 'inventory status'] },
  { key: 'receivedDate', label: 'Received date', type: 'date', group: 'unit', synonyms: ['received', 'received date', 'date received', 'recv date', 'rcvd', 'arrival date', 'in stock date', 'stock date', 'date in stock'] },
  { key: 'listPriceCents', label: 'List price', type: 'money', group: 'unit', synonyms: ['list', 'list price', 'msrp', 'retail', 'retail price', 'suggested retail'] },
];

const UNIT_FIELDS: TargetField[] = [
  ...UNIT_CORE,
  { key: 'dmsInvoiceCostCents', label: 'Dealer invoice cost', type: 'money', group: 'unit', hint: 'Used to check a flooring against the dealer system. It does not book cost by itself.', synonyms: ['cost', 'invoice cost', 'unit cost', 'dealer cost', 'inv cost', 'invoice amount', 'dealer invoice', 'net cost'] },
  { key: 'lenderInvoiceNumber', label: 'Lender invoice #', type: 'text', max: 100, group: 'floor', hint: 'Needed only to floor the unit on the line you chose.', synonyms: ['invoice #', 'inv #', 'invoice no', 'invoice number', 'inv no', 'lender invoice', 'flooring #', 'note #', 'note no', 'floor #'] },
  { key: 'flooredDate', label: 'Floored date', type: 'date', group: 'floor', synonyms: ['floored date', 'floor date', 'floored', 'financed date', 'date floored', 'funding date', 'flooring date'] },
  { key: 'principalCents', label: 'Floored amount', type: 'money', group: 'floor', synonyms: ['principal', 'floored amount', 'amount financed', 'financed amount', 'orig bal', 'original balance', 'floor amount', 'floored', 'original principal'] },
];

const OPENING_FIELDS: TargetField[] = [
  ...UNIT_CORE,
  { key: 'lenderInvoiceNumber', label: 'Lender invoice #', type: 'text', max: 100, group: 'floor', hint: 'For units still owed to the lender at go-live.', synonyms: ['invoice #', 'inv #', 'invoice no', 'invoice number', 'inv no', 'lender invoice', 'flooring #', 'note #', 'note no'] },
  { key: 'flooredDate', label: 'Originally floored', type: 'date', group: 'floor', synonyms: ['floored date', 'floor date', 'floored', 'financed date', 'date floored', 'funding date'] },
  { key: 'principalCents', label: 'Principal owed at go-live', type: 'money', group: 'floor', synonyms: ['current balance', 'curr bal', 'balance', 'principal', 'balance due', 'principal balance', 'unpaid balance', 'outstanding', 'payoff'] },
  { key: 'interestAccruedThrough', label: 'Interest paid through', type: 'date', group: 'floor', hint: 'Blank means the floored date.', synonyms: ['interest paid through', 'interest through', 'accrued through', 'paid through', 'interest paid thru', 'paid thru'] },
];

const DEAL_FIELDS: TargetField[] = [
  { key: 'externalDealRef', label: 'Deal number', type: 'text', required: true, max: 200, hint: 'Re-importing the same deal number never creates a second sale.', synonyms: ['deal #', 'deal no', 'deal number', 'deal', 'deal id', 'contract #', 'contract no', 'buyers order', 'buyers order #', 'bo #', 'invoice #', 'sale #'] },
  { key: 'saleDate', label: 'Sale date', type: 'date', required: true, synonyms: ['sale date', 'deal date', 'sold date', 'date sold', 'delivery date', 'contract date', 'date'] },
  { ...SERIAL, label: 'Unit serial number', hint: 'Must match a unit already in Books.' },
  { key: 'customer', label: 'Customer', type: 'text', required: true, max: 200, hint: 'Matched to a customer in Books by name.', synonyms: ['customer', 'customer name', 'buyer', 'purchaser', 'sold to', 'name', 'cust name'] },
  { key: 'salePriceCents', label: 'Sale price', type: 'money', required: true, synonyms: ['sale price', 'selling price', 'price', 'unit price', 'cash price', 'sales price', 'amount'] },
  { key: 'taxCents', label: 'Sales tax', type: 'money', synonyms: ['tax', 'sales tax', 'tax amount'] },
  { key: 'retailRebateCents', label: 'Retail rebate', type: 'money', hint: 'Needs the manufacturer program you chose.', synonyms: ['rebate', 'retail rebate', 'mfr rebate', 'customer rebate', 'factory rebate'] },
  { key: 'salesperson', label: 'Salesperson', type: 'text', max: 200, synonyms: ['salesperson', 'sales rep', 'salesman', 'rep', 'sales person'] },
  { key: 'tradeSerial', label: 'Trade serial number', type: 'text', max: 100, group: 'trade', synonyms: ['trade serial', 'trade sn', 'trade in serial', 'trade vin', 'trade serial #', 'trade-in serial'] },
  { key: 'tradeModel', label: 'Trade model', type: 'text', max: 200, group: 'trade', synonyms: ['trade model', 'trade-in model', 'trade description'] },
  { key: 'tradeYear', label: 'Trade year', type: 'int', group: 'trade', synonyms: ['trade year', 'trade yr', 'trade-in year'] },
  { key: 'tradeAllowanceCents', label: 'Trade allowance', type: 'money', group: 'trade', synonyms: ['trade allowance', 'allowance', 'trade value', 'trade-in allowance', 'trade in allowance', 'trade'] },
  { key: 'tradeAcvCents', label: 'Trade ACV (actual cash value)', type: 'money', group: 'trade', hint: 'A sales manager always approves the ACV.', synonyms: ['acv', 'trade acv', 'actual cash value', 'trade-in acv'] },
  { key: 'tradeLienPayoffCents', label: 'Trade lien payoff', type: 'money', group: 'trade', synonyms: ['lien payoff', 'payoff', 'trade payoff', 'lien', 'lien amount', 'trade lien'] },
];

const WARRANTY_FIELDS: TargetField[] = [
  { key: 'oemClaimNumber', label: 'Manufacturer claim #', type: 'text', max: 100, synonyms: ['claim #', 'claim no', 'claim number', 'oem claim', 'mfr claim', 'manufacturer claim', 'claim id', 'claim'] },
  { key: 'dealerClaimRef', label: 'Dealer claim reference', type: 'text', max: 100, synonyms: ['dealer claim', 'dealer ref', 'our claim', 'internal claim', 'dealer claim #', 'reference'] },
  { key: 'repairOrderRef', label: 'Repair order #', type: 'text', max: 100, synonyms: ['ro', 'ro #', 'ro no', 'repair order', 'repair order #', 'work order', 'wo #', 'wo'] },
  { ...SERIAL, required: false },
  { key: 'failureDate', label: 'Failure date', type: 'date', synonyms: ['failure date', 'fail date', 'date of failure'] },
  { key: 'repairDate', label: 'Repair date', type: 'date', synonyms: ['repair date', 'date repaired', 'ro date', 'completed', 'completion date', 'repair completed'] },
  { key: 'filingDeadline', label: 'Filing deadline', type: 'date', synonyms: ['deadline', 'filing deadline', 'submit by', 'due', 'due date', 'file by'] },
  { key: 'laborHours', label: 'Labor hours', type: 'hours', required: true, synonyms: ['hours', 'labor hours', 'hrs', 'flat rate hours', 'labor hrs', 'time'] },
  { key: 'laborRateCents', label: 'Warranty labor rate (per hour)', type: 'money', required: true, synonyms: ['labor rate', 'rate', 'warranty rate', 'hourly rate', 'labor rate per hour'] },
  { key: 'partsCostCents', label: 'Parts at cost', type: 'money', required: true, synonyms: ['parts cost', 'parts', 'part cost', 'parts at cost', 'parts amount'] },
  { key: 'partsMarkupBps', label: 'Parts markup %', type: 'pct', hint: 'Blank means no markup.', synonyms: ['markup', 'parts markup', 'markup %', 'parts markup %', 'markup pct'] },
  { key: 'subletCents', label: 'Sublet', type: 'money', synonyms: ['sublet', 'sublet amount'] },
  { key: 'freightCents', label: 'Freight', type: 'money', synonyms: ['freight', 'shipping'] },
  { key: 'otherCents', label: 'Other', type: 'money', synonyms: ['other', 'misc', 'miscellaneous'] },
  { key: 'claimedTotalCents', label: 'Claim total (check only)', type: 'money', group: 'check', hint: 'If mapped, each row must add up to this total.', synonyms: ['total', 'claim total', 'claimed', 'amount claimed', 'total claimed', 'claim amount'] },
];

export const LENDER_LINE_FIELDS: TargetField[] = [
  { key: 'lenderInvoiceNumber', label: 'Lender invoice #', type: 'text', max: 100, hint: 'An invoice # or a serial number is needed on each line.', synonyms: ['invoice #', 'inv #', 'invoice no', 'invoice number', 'inv no', 'note #', 'note no', 'flooring #', 'invoice'] },
  { key: 'serialNumber', label: 'Serial number', type: 'text', max: 100, synonyms: SERIAL.synonyms },
  { key: 'model', label: 'Model', type: 'text', max: 200, synonyms: ['model', 'model #', 'model number', 'description', 'desc', 'collateral'] },
  { key: 'originalCents', label: 'Original amount', type: 'money', synonyms: ['orig bal', 'original balance', 'original amount', 'orig amt', 'original principal', 'amount financed', 'financed', 'orig principal', 'original'] },
  { key: 'currentCents', label: 'Current principal', type: 'money', required: true, hint: 'Lines must add up to the statement’s principal total.', synonyms: ['curr bal', 'current balance', 'balance', 'principal balance', 'current principal', 'unpaid balance', 'outstanding', 'principal due', 'principal', 'cur bal', 'current'] },
  { key: 'interestCents', label: 'Interest', type: 'money', synonyms: ['interest', 'interest due', 'finance charge', 'int', 'interest amount'] },
  { key: 'feesCents', label: 'Fees', type: 'money', synonyms: ['fees', 'fee', 'other charges', 'charges', 'late fee'] },
  { key: 'lenderCode', label: 'Lender status code', type: 'text', max: 20, hint: 'Sold-and-unpaid codes are set on the floor-plan line.', synonyms: ['code', 'status', 'status code', 'lender code', 'stat', 'audit code', 'condition code'] },
  { key: 'dispositionDate', label: 'Sold / paid date', type: 'date', synonyms: ['disposition date', 'sold date', 'date sold', 'payoff date', 'paid date', 'disp date'] },
  { key: 'days', label: 'Days on floor', type: 'int', synonyms: ['days', 'age', 'days floored', 'days on floor', 'days out'] },
];

const OEM_TYPE_OPTIONS: readonly EnumOption[] = [
  { value: 'WARRANTY_CREDIT', label: 'Warranty credit', synonyms: ['warranty', 'warranty credit', 'wty', 'war', 'claim credit', 'warranty claim', 'wrty'] },
  { value: 'INCENTIVE_CREDIT', label: 'Incentive credit', synonyms: ['incentive', 'incentive credit', 'rebate', 'program', 'bonus', 'holdback', 'co op', 'coop', 'spiff', 'program credit'] },
  { value: 'DEBIT', label: 'Debit / chargeback', synonyms: ['debit', 'chargeback', 'charge back', 'debit memo', 'reversal'] },
  { value: 'PARTS_INVOICE', label: 'Parts invoice', synonyms: ['parts', 'parts invoice', 'parts order', 'invoice'] },
  { value: 'OTHER', label: 'Other', synonyms: ['other', 'misc', 'miscellaneous', 'adjustment'] },
];

export const OEM_LINE_FIELDS: TargetField[] = [
  { key: 'lineType', label: 'Line type', type: 'enum', options: OEM_TYPE_OPTIONS, hint: 'Blank uses the default you chose.', synonyms: ['type', 'line type', 'transaction type', 'trans type', 'category', 'kind', 'doc type', 'document type'] },
  { key: 'reference', label: 'Claim # / reference', type: 'text', max: 100, synonyms: ['claim #', 'claim no', 'claim number', 'reference', 'ref', 'ref #', 'document #', 'doc #', 'credit memo #', 'memo #', 'claim'] },
  { key: 'serialNumber', label: 'Serial number', type: 'text', max: 100, synonyms: SERIAL.synonyms },
  { key: 'description', label: 'Description', type: 'text', max: 500, synonyms: ['description', 'desc', 'memo', 'details', 'detail', 'explanation'] },
  { key: 'amountCents', label: 'Amount (credits positive)', type: 'signedMoney', hint: 'Or map separate credit and debit columns below.', synonyms: ['amount', 'net amount', 'net', 'total', 'amount due', 'line amount'] },
  { key: 'creditCents', label: 'Credit column', type: 'money', group: 'check', hint: 'Used when there is no single amount column.', synonyms: ['credit', 'credits', 'cr', 'credit amount'] },
  { key: 'debitCents', label: 'Debit column', type: 'money', group: 'check', hint: 'Used when there is no single amount column.', synonyms: ['debit', 'debits', 'dr', 'debit amount', 'charge'] },
];

export const PROGRAM_TYPE_OPTIONS: readonly EnumOption[] = [
  { value: 'RETAIL_REBATE', label: 'Retail rebate', synonyms: ['retail rebate', 'customer rebate', 'consumer rebate', 'cash back', 'retail'] },
  { value: 'DEALER_REBATE', label: 'Dealer rebate', synonyms: ['dealer rebate', 'dealer cash', 'dealer incentive', 'dealer'] },
  { value: 'VOLUME_BONUS', label: 'Volume bonus', synonyms: ['volume', 'volume bonus', 'tier bonus', 'target bonus', 'volume incentive'] },
  { value: 'HOLDBACK', label: 'Holdback', synonyms: ['holdback', 'hold back'] },
  { value: 'CO_OP', label: 'Co-op advertising', synonyms: ['co op', 'coop', 'co-op', 'advertising', 'co op advertising'] },
  { value: 'SPIFF', label: 'Salesperson spiff', synonyms: ['spiff', 'salesperson incentive', 'sales spiff'] },
  { value: 'INTEREST_SUBSIDY', label: 'Retail interest subsidy', synonyms: ['interest subsidy', 'rate buydown', 'low rate', 'finance subsidy', 'subvention'] },
  { value: 'FLOOR_PLAN_SUPPORT', label: 'Floor-plan support', synonyms: ['floor plan support', 'flooring support', 'free floor', 'interest assistance', 'floorplan support'] },
  { value: 'DEMO_SUPPORT', label: 'Demo support', synonyms: ['demo', 'demo support', 'demonstrator support'] },
  { value: 'OTHER', label: 'Other', synonyms: ['other'] },
];

const TREATMENT_OPTIONS: readonly EnumOption[] = [
  { value: 'TRANSACTION_PRICE', label: 'Part of the sale price', synonyms: ['transaction price', 'revenue', 'sale price'] },
  { value: 'COST_REDUCTION', label: 'Reduces unit cost', synonyms: ['cost reduction', 'reduce cost', 'cogs'] },
  { value: 'EXPENSE_REIMBURSEMENT', label: 'Reimburses an expense', synonyms: ['expense reimbursement', 'reimbursement', 'expense'] },
  { value: 'PASS_THROUGH', label: 'Passed to the customer', synonyms: ['pass through', 'passthrough', 'pass-through'] },
];

const PROGRAM_FIELDS: TargetField[] = [
  { key: 'programCode', label: 'Program code', type: 'text', max: 100, synonyms: ['code', 'program code', 'program #', 'program id', 'program no', 'bulletin #'] },
  { key: 'name', label: 'Program name', type: 'text', required: true, max: 200, synonyms: ['name', 'program', 'program name', 'title', 'description'] },
  { key: 'programType', label: 'Program type', type: 'enum', required: true, options: PROGRAM_TYPE_OPTIONS, synonyms: ['type', 'program type', 'category', 'incentive type'] },
  { key: 'treatment', label: 'Accounting treatment', type: 'enum', options: TREATMENT_OPTIONS, hint: 'Blank uses the usual treatment for the type.', synonyms: ['treatment', 'accounting treatment'] },
  { key: 'paidDirect', label: 'Paid straight to the customer', type: 'bool', synonyms: ['paid direct', 'paid to customer', 'direct', 'paid direct to customer'] },
  { key: 'startDate', label: 'Start date', type: 'date', synonyms: ['start', 'start date', 'effective', 'effective date', 'begins', 'from'] },
  { key: 'endDate', label: 'End date', type: 'date', synonyms: ['end', 'end date', 'expires', 'expiration', 'through', 'to'] },
  { key: 'claimDeadlineDays', label: 'Days allowed to claim', type: 'int', synonyms: ['claim deadline', 'days to claim', 'claim within', 'claim days', 'deadline days'] },
  { key: 'amountCents', label: 'Amount per unit', type: 'money', synonyms: ['amount', 'per unit', 'rebate amount', 'incentive amount', 'amount per unit'] },
  { key: 'eligibleModels', label: 'Eligible models', type: 'text', max: 1000, synonyms: ['models', 'eligible models', 'eligible units', 'model'] },
  { key: 'notes', label: 'Notes / rules', type: 'text', max: 2000, synonyms: ['notes', 'rules', 'conditions', 'terms', 'requirements'] },
];

export const KIND_FIELDS: Record<ImportFileKind, readonly TargetField[]> = {
  UNITS: UNIT_FIELDS,
  OPENING: OPENING_FIELDS,
  DEALS: DEAL_FIELDS,
  WARRANTY: WARRANTY_FIELDS,
  LENDER_STATEMENT: LENDER_LINE_FIELDS,
  LENDER_AUDIT: LENDER_LINE_FIELDS,
  OEM_STATEMENT: OEM_LINE_FIELDS,
  PROGRAMS: PROGRAM_FIELDS,
};

export const ROW_NOUN: Record<ImportFileKind, string> = {
  UNITS: 'unit',
  OPENING: 'unit',
  DEALS: 'deal',
  WARRANTY: 'claim',
  LENDER_STATEMENT: 'line',
  LENDER_AUDIT: 'line',
  OEM_STATEMENT: 'line',
  PROGRAMS: 'program',
};

export function isStatementKind(kind: ImportFileKind): kind is 'LENDER_STATEMENT' | 'LENDER_AUDIT' | 'OEM_STATEMENT' {
  return kind === 'LENDER_STATEMENT' || kind === 'LENDER_AUDIT' || kind === 'OEM_STATEMENT';
}

export function isLenderKind(kind: ImportFileKind): kind is 'LENDER_STATEMENT' | 'LENDER_AUDIT' {
  return kind === 'LENDER_STATEMENT' || kind === 'LENDER_AUDIT';
}

export function fieldOf(kind: ImportFileKind, key: string): TargetField | undefined {
  return KIND_FIELDS[kind].find((f) => f.key === key);
}
