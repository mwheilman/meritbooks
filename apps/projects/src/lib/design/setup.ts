/**
 * Interior design firm setup (ID-01): firm type, fee models, markup policy, deposit and retainer
 * policy, receivers, tax states, the tool being replaced → the plan pm.wc_apply_setup writes.
 * Pure; unit-tested.
 */

export const FIRM_TYPES = ['RESIDENTIAL_FULL_SERVICE', 'E_DESIGN', 'COMMERCIAL_FFE', 'DESIGN_BUILD'] as const;
export type FirmType = (typeof FIRM_TYPES)[number];
export const FEE_MODELS = ['HOURLY', 'FLAT_BY_PHASE', 'PCT_OF_BUDGET', 'COST_PLUS', 'PROCUREMENT_FEE', 'HYBRID'] as const;
export type FeeModel = (typeof FEE_MODELS)[number];

export interface DesignAnswers {
  firmType: FirmType;
  feeModels: FeeModel[];
  markupPct: number;
  productDepositPct: number;
  retainerCents: number;
  retainerEvergreen: boolean;
  showCostToClients: boolean;
  receivers: Array<{ name: string; address: string }>;
  taxStates: string[];
  replacing: string | null;
}

export interface DesignPlan {
  settings: Record<string, unknown>;
  cost_codes: Array<{ code: string; name: string; cost_type: 'LABOR' | 'MATERIALS' | 'SUBCONTRACTOR' | 'EQUIPMENT' | 'OTHER' }>;
  receivers: Array<{ name: string; address: string }>;
  books_accounts: Record<string, string>;
}

export function buildDesignPlan(a: DesignAnswers): DesignPlan {
  const fees = a.feeModels.length ? [...new Set(a.feeModels)] : (['HOURLY'] as FeeModel[]);
  return {
    settings: {
      firm_type: a.firmType,
      fee_models: fees,
      default_markup_pct: Math.min(Math.max(a.markupPct, 0), 10),
      product_deposit_pct: Math.min(Math.max(a.productDepositPct, 0), 1),
      retainer_cents: Math.max(0, Math.round(a.retainerCents)),
      retainer_evergreen: a.retainerEvergreen,
      show_cost_default: a.showCostToClients,
      tax_states: a.taxStates.map((s) => s.toUpperCase()).filter((s) => /^[A-Z]{2}$/.test(s)),
      replacing_system: a.replacing,
    },
    cost_codes: [
      { code: 'DS-100', name: 'Design fees', cost_type: 'LABOR' },
      { code: 'DS-200', name: 'Furnishings and products', cost_type: 'MATERIALS' },
      { code: 'DS-210', name: 'Workroom (drapery, upholstery)', cost_type: 'SUBCONTRACTOR' },
      { code: 'DS-300', name: 'Freight, receiving and storage', cost_type: 'OTHER' },
      { code: 'DS-400', name: 'Delivery and install', cost_type: 'SUBCONTRACTOR' },
      { code: 'DS-900', name: 'Reimbursable expenses', cost_type: 'OTHER' },
    ],
    receivers: a.receivers.filter((r) => r.name.trim() !== '').slice(0, 20),
    books_accounts: {
      client_deposits: 'Client deposits (liability)',
      vendor_deposits: 'Vendor deposits (prepaid asset)',
      design_fee_income: 'Design fee income',
      product_sales: 'Product sales',
      ...(fees.includes('PROCUREMENT_FEE') ? { procurement_fees: 'Procurement fee income' } : {}),
    },
  };
}
