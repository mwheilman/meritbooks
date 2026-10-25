/**
 * Residential setup interview (RES-01): about ten questions → the plan pm.wc_apply_setup writes
 * (settings, cost codes, payment schedule template, selections library, portal defaults, builder
 * job types, and the Books account map). The person sees the plan before it is applied.
 * Rules only (AI classification from the website / QBO items plugs in later). Pure; unit-tested.
 */

export type BusinessKind = 'remodel' | 'custom' | 'production' | 'hybrid';
export type ContractKind = 'FIXED_PRICE' | 'COST_PLUS_PCT' | 'COST_PLUS_FEE' | 'COST_PLUS_GMP' | 'TIME_MATERIALS';
export type BillingMethod = 'MILESTONE' | 'PROGRESS' | 'DRAW' | 'COST_PLUS' | 'MIXED';
export type SelfPerform = 'SELF_PERFORM' | 'SUBCONTRACT' | 'MIXED';

export interface ResidentialAnswers {
  businessKind: BusinessKind;
  contractTypes: ContractKind[];
  billingMethod: BillingMethod;
  selfPerform: SelfPerform;
  stateCode: string | null;
  /** Retail sale + install (taxed on materials) or lump-sum improvement (contractor pays use tax). */
  taxForm: 'LUMP_SUM_IMPROVEMENT' | 'RETAIL_PLUS_INSTALL' | 'EXEMPT';
  depositPct: number;
  markupPct: number;
  workmanshipWarrantyMonths: number;
  structuralWarrantyYears: number;
  usesSelectionsPortal: boolean;
}

export const RESIDENTIAL_QUESTIONS: ReadonlyArray<{ key: keyof ResidentialAnswers; label: string; help: string }> = [
  { key: 'businessKind', label: 'What do you build?', help: 'Remodeling, custom homes on the client\'s lot, production homes in communities, or a mix.' },
  { key: 'contractTypes', label: 'How do you contract?', help: 'Fixed price, cost-plus (percent, fee or GMP), or time and materials. Pick every one you use.' },
  { key: 'billingMethod', label: 'How do you bill?', help: 'Milestone payments, monthly progress, construction-loan draws, or cost-plus invoices.' },
  { key: 'selfPerform', label: 'Who does the work?', help: 'Your own crews, trade partners, or both. It decides how cost codes are typed.' },
  { key: 'stateCode', label: 'Which state do you mostly work in?', help: 'Sets the cancellation notice, deposit caps and how labor is taxed.' },
  { key: 'taxForm', label: 'How is sales tax handled?', help: 'Lump-sum improvement (you pay tax on materials) or retail sale plus installation.' },
  { key: 'depositPct', label: 'Deposit at signing', help: 'A percent of the contract (state caps still apply).' },
  { key: 'markupPct', label: 'Your usual markup', help: 'Used when a catalog line has none of its own.' },
  { key: 'workmanshipWarrantyMonths', label: 'Workmanship warranty', help: 'Months; it schedules the 30-day and 11-month walks.' },
  { key: 'structuralWarrantyYears', label: 'Structural warranty (builders)', help: 'Years; 0 for remodel-only.' },
  { key: 'usesSelectionsPortal', label: 'Do homeowners pick selections online?', help: 'Turns on the selections library and the portal defaults.' },
];

export interface PlanCostCode { code: string; name: string; cost_type: 'LABOR' | 'MATERIALS' | 'SUBCONTRACTOR' | 'EQUIPMENT' | 'OTHER' }
export interface PlanPayment { label: string; kind: 'DEPOSIT' | 'MILESTONE' | 'FINAL'; pct: number; trigger_ref: string | null }

export interface ResidentialPlan {
  settings: Record<string, unknown>;
  cost_codes: PlanCostCode[];
  payment_template: PlanPayment[];
  selection_library: Array<{ category: string; title: string; room: string }>;
  portal_defaults: Record<string, boolean>;
  builder_job_types: boolean;
  books_accounts: Record<string, string>;
}

const TRADES: ReadonlyArray<[string, string, boolean]> = [
  // code, name, usually self-performed by a remodeler
  ['01-000', 'General conditions', true], ['02-000', 'Demolition', true], ['03-000', 'Concrete and foundation', false],
  ['06-000', 'Framing and carpentry', true], ['07-000', 'Roofing and insulation', false], ['08-000', 'Windows and doors', true],
  ['09-000', 'Drywall and paint', false], ['09-600', 'Flooring and tile', false], ['10-000', 'Cabinets and countertops', true],
  ['15-000', 'Plumbing', false], ['15-500', 'HVAC', false], ['16-000', 'Electrical', false],
];
const BUILDER_TRADES: ReadonlyArray<[string, string]> = [['31-000', 'Sitework and excavation'], ['32-000', 'Landscaping'], ['33-000', 'Utilities and permits']];

function costType(selfPerform: SelfPerform, usual: boolean): PlanCostCode['cost_type'] {
  if (selfPerform === 'SELF_PERFORM') return 'LABOR';
  if (selfPerform === 'SUBCONTRACT') return 'SUBCONTRACTOR';
  return usual ? 'LABOR' : 'SUBCONTRACTOR';
}

/** Payment schedule: always sums to 100 % (the final payment takes the remainder). */
export function paymentTemplate(method: BillingMethod, depositPct: number): PlanPayment[] {
  const dep = Math.min(Math.max(depositPct, 0), 0.5);
  if (method === 'DRAW' || method === 'COST_PLUS' || method === 'PROGRESS') {
    return [{ label: 'Deposit', kind: 'DEPOSIT', pct: dep, trigger_ref: null }, { label: 'Final', kind: 'FINAL', pct: round4(1 - dep), trigger_ref: 'complete' }];
  }
  const mids: Array<[string, string]> = [['Demolition complete', 'demolition'], ['Rough-ins inspected', 'rough_in'], ['Cabinets set', 'cabinets']];
  const each = round4((1 - dep - 0.1) / mids.length);
  const out: PlanPayment[] = [{ label: 'Deposit', kind: 'DEPOSIT', pct: dep, trigger_ref: null }];
  for (const [label, ref] of mids) out.push({ label, kind: 'MILESTONE', pct: each, trigger_ref: ref });
  out.push({ label: 'Final', kind: 'FINAL', pct: round4(1 - dep - each * mids.length), trigger_ref: 'complete' });
  return out;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function buildResidentialPlan(a: ResidentialAnswers): ResidentialPlan {
  const builder = a.businessKind !== 'remodel';
  const codes: PlanCostCode[] = TRADES.map(([code, name, usual]) => ({ code, name, cost_type: costType(a.selfPerform, usual) }));
  if (builder) for (const [code, name] of BUILDER_TRADES) codes.push({ code, name, cost_type: 'SUBCONTRACTOR' });
  codes.push({ code: '90-000', name: 'Permits and fees', cost_type: 'OTHER' }, { code: '91-000', name: 'Dumpsters and site services', cost_type: 'OTHER' });
  const primary: ContractKind = a.contractTypes[0] ?? 'FIXED_PRICE';
  const walkDays = [30, Math.max(30, Math.round(a.workmanshipWarrantyMonths * 30.4) - 30)];
  if (builder && a.structuralWarrantyYears > 0) walkDays.push(730);
  const library = a.usesSelectionsPortal
    ? [
        ['Cabinets', 'Cabinet door style and finish', 'Kitchen'], ['Countertops', 'Countertop material and edge', 'Kitchen'], ['Tile', 'Backsplash tile', 'Kitchen'],
        ['Plumbing', 'Sink and faucet', 'Kitchen'], ['Plumbing', 'Shower valve and trim', 'Bathroom'], ['Tile', 'Shower wall tile', 'Bathroom'],
        ['Flooring', 'Floor tile or LVP', 'Bathroom'], ['Electrical', 'Light fixtures', 'Whole house'], ['Paint', 'Paint colors', 'Whole house'],
        ['Hardware', 'Cabinet hardware', 'Kitchen'],
      ].map(([category, title, room]) => ({ category: category!, title: title!, room: room! }))
    : [];
  return {
    settings: {
      business_kind: a.businessKind,
      default_contract_type: primary,
      default_tax_form: a.taxForm,
      state_code: a.stateCode && /^[A-Z]{2}$/.test(a.stateCode) ? a.stateCode : null,
      default_deposit_pct: Math.min(Math.max(a.depositPct, 0), 1),
      default_markup_pct: Math.min(Math.max(a.markupPct, 0), 10),
      billing_method: a.billingMethod,
      self_perform_mix: a.selfPerform,
      structural_warranty_years: builder ? a.structuralWarrantyYears : 0,
      warranty_walk_days: walkDays,
    },
    cost_codes: codes,
    payment_template: paymentTemplate(a.billingMethod, a.depositPct),
    selection_library: library,
    portal_defaults: { selections: a.usesSelectionsPortal, schedule_milestones: true, daily_photos: true, invoices: true, change_orders: true },
    builder_job_types: builder,
    books_accounts: {
      customer_deposits: 'Customer deposits (liability)',
      retainage_receivable: 'Retainage receivable',
      wip_over_billing: 'Billings in excess of cost (WIP)',
      wip_under_billing: 'Cost in excess of billings (WIP)',
      ...(builder ? { spec_inventory: 'Construction in progress — spec homes (inventory)' } : {}),
    },
  };
}
