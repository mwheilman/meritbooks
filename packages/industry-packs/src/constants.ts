/**
 * Package-level constants: human labels for the closed vocabularies in types.ts, the approval
 * roles packs may name, and the small set of params the compiler understands natively.
 */
import type {
  AccountRoleHint, BillingMode, CostType, ModuleKey, ProgressBasis, RevRecHint,
} from './types';

/** Roles an approval tier may name. The app maps these to membership roles. */
export const APPROVAL_ROLES = [
  'pm', 'superintendent', 'service_manager', 'ops_manager', 'principal', 'controller', 'owner',
] as const;
export type ApprovalRole = (typeof APPROVAL_ROLES)[number];

export const APPROVAL_ROLE_LABELS: Record<ApprovalRole, string> = {
  pm: 'Project manager',
  superintendent: 'Superintendent',
  service_manager: 'Service manager',
  ops_manager: 'Operations manager',
  principal: 'Principal',
  controller: 'Controller',
  owner: 'Owner',
};

export const MODULE_LABELS: Record<ModuleKey, string> = {
  estimates: 'Estimates',
  budget: 'Budgets by cost code',
  schedule: 'Schedule',
  change_orders: 'Change orders',
  commitments: 'Purchase orders and subcontracts',
  billing: 'Billing',
  retainage: 'Retainage',
  allowances: 'Allowances',
  selections: 'Selections',
  daily_logs: 'Daily logs',
  punch_warranty: 'Punch lists and warranty',
  time: 'Time tracking',
  dispatch: 'Dispatch board',
  service_agreements: 'Service agreements',
  assets: 'Equipment and serial numbers',
  production: 'Shop production',
  procurement_markup: 'Purchasing with markup',
  lots_units: 'Lots and units',
  lender_draws: 'Lender draws',
  rfis_submittals: 'RFIs and submittals',
  compliance: 'COIs and lien waivers',
  documents: 'Documents',
  client_approvals: 'Client approvals and e-sign',
};

export const BILLING_MODE_LABELS: Record<BillingMode, string> = {
  FIXED: 'fixed price',
  PROGRESS_PCT: 'percent complete',
  SOV: 'pay application (schedule of values)',
  MILESTONE: 'milestones',
  TIME_MATERIALS: 'time and materials',
  DRAW: 'draws',
  DEPOSIT: 'deposit, then balance',
  RECURRING: 'recurring',
};

export const PROGRESS_BASIS_LABELS: Record<ProgressBasis, string> = {
  NONE: 'no progress tracking',
  COST_TO_COST: 'cost to date ÷ estimated cost',
  PHYSICAL_PCT: 'physical percent complete',
  UNITS: 'units installed',
  MILESTONES: 'milestones reached',
};

export const COST_TYPE_LABELS: Record<CostType, string> = {
  LABOR: 'Labor',
  MATERIALS: 'Materials',
  SUBCONTRACTOR: 'Subcontractors',
  EQUIPMENT: 'Equipment',
  OTHER: 'Other',
};

export const ROLE_HINT_LABELS: Record<AccountRoleHint, string> = {
  DIRECT_LABOR_COST: 'Direct labor cost',
  MATERIALS_COST: 'Materials cost',
  SUBCONTRACT_COST: 'Subcontract cost',
  EQUIPMENT_COST: 'Equipment cost',
  OTHER_JOB_COST: 'Other job cost',
  PERMITS_FEES_COST: 'Permits and fees',
  FREIGHT_COST: 'Freight',
  DESIGN_FEE_REVENUE: 'Design fee revenue',
  SERVICE_REVENUE: 'Service revenue',
  CONTRACT_REVENUE: 'Contract revenue',
  PRODUCT_REVENUE: 'Product revenue',
  WARRANTY_COST: 'Warranty cost',
  LAND_COST: 'Land cost',
  SOFT_COST: 'Soft cost',
};

export const REV_REC_HINT_LABELS: Record<RevRecHint, string> = {
  PCT_COSTS_INCURRED: 'percent complete (cost to cost)',
  PCT_COMPLETE: 'percent complete',
  COMPLETED_CONTRACT: 'completed contract',
  MILESTONE: 'at each milestone',
  AS_BILLED: 'as billed',
  RATABLY: 'evenly over the term',
  SUBSCRIPTION: 'over the agreement term',
  POINT_IN_TIME: 'at completion or closing',
};

/**
 * Books' `rev_rec_method_enum` spells one value differently from the hint list. The proposal keeps
 * the hint label (contract shape); Books' onboarding maps it with this table.
 */
export const REV_REC_HINT_TO_BOOKS_METHOD: Record<RevRecHint, string> = {
  PCT_COSTS_INCURRED: 'PCT_COSTS_INCURRED',
  PCT_COMPLETE: 'PCT_COMPLETE',
  COMPLETED_CONTRACT: 'COMPLETED_CONTRACT',
  MILESTONE: 'MILESTONE',
  AS_BILLED: 'AS_BILLED',
  RATABLY: 'RATABLY',
  SUBSCRIPTION: 'SUBSCRIPTION',
  POINT_IN_TIME: 'POINT_OF_SALE',
};

/** Fallback cost type → account role when no cost code of that type carries a hint. */
export const DEFAULT_COST_TYPE_ROLES: Record<CostType, AccountRoleHint> = {
  LABOR: 'DIRECT_LABOR_COST',
  MATERIALS: 'MATERIALS_COST',
  SUBCONTRACTOR: 'SUBCONTRACT_COST',
  EQUIPMENT: 'EQUIPMENT_COST',
  OTHER: 'OTHER_JOB_COST',
};

/**
 * Params the compiler reads directly (every other param is carried to the plan for the app).
 * - uses_retainage (bool): turns the retainage module on/off for retainage-eligible job types.
 * - retainage_pct (percent, 0..0.2): when set explicitly, the default retainage for every job
 *   type with retainage on; otherwise each job type keeps its own default.
 */
export const WELL_KNOWN_PARAMS = {
  uses_retainage: 'bool',
  retainage_pct: 'percent',
} as const;

/** Billing modes under which retainage can apply (contract/progress billing). */
export const RETAINAGE_BILLING_MODES: readonly BillingMode[] = ['SOV', 'PROGRESS_PCT', 'DRAW'];

/** Copy rule for every user-facing string this package produces. */
export const BANNED_WORDS = ['portfolio', 'synergy', 'leverage', 'world-class', 'revolutionize', 'solutions'] as const;
export const BANNED_WORDS_RE = /\b(portfolio|synergy|synergies|leverage|world[- ]class|revolutioni[sz]e|solutions)\b/i;
