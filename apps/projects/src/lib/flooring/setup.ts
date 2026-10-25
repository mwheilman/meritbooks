/**
 * Flooring setup (FLR-01): business mix, installer pay basis, deposit policy, tax states and the
 * system being replaced → the plan pm.wc_apply_setup writes (settings, cost codes, a starter labor
 * price list). Pure; unit-tested.
 */

export const FLOORING_MIX = ['RETAIL_INSTALLED', 'CASH_AND_CARRY', 'BUILDER', 'MULTI_FAMILY', 'COMMERCIAL', 'INSURANCE'] as const;
export type FlooringMix = (typeof FLOORING_MIX)[number];

export interface FlooringAnswers {
  mix: FlooringMix[];
  installerPay: 'PIECE_RATE' | 'HOURLY' | 'MIXED';
  depositPct: number;
  taxStates: string[];
  replacing: string | null;
  measureFeeCents: number;
}

export interface FlooringPlan {
  settings: Record<string, unknown>;
  cost_codes: Array<{ code: string; name: string; cost_type: 'LABOR' | 'MATERIALS' | 'SUBCONTRACTOR' | 'EQUIPMENT' | 'OTHER' }>;
  labor_rates: Array<{ code: string; description: string; unit: 'SY' | 'SF' | 'LF' | 'STEP' | 'EA' | 'JOB' | 'HOUR'; applies_to: string; sell_cents: number; pay_cents: number }>;
  books_accounts: Record<string, string>;
}

export function buildFlooringPlan(a: FlooringAnswers): FlooringPlan {
  const mix = a.mix.length ? [...new Set(a.mix)] : (['RETAIL_INSTALLED'] as FlooringMix[]);
  const installLabor = a.installerPay === 'HOURLY' ? 'LABOR' : 'SUBCONTRACTOR';
  return {
    settings: {
      business_mix: mix,
      installer_pay_basis: a.installerPay,
      default_deposit_pct: Math.min(Math.max(a.depositPct, 0), 1),
      tax_states: a.taxStates.map((s) => s.toUpperCase()).filter((s) => /^[A-Z]{2}$/.test(s)),
      replacing_system: a.replacing,
      measure_fee_cents: Math.max(0, Math.round(a.measureFeeCents)),
    },
    cost_codes: [
      { code: 'FL-100', name: 'Flooring material', cost_type: 'MATERIALS' },
      { code: 'FL-110', name: 'Pad and underlayment', cost_type: 'MATERIALS' },
      { code: 'FL-120', name: 'Sundries and transitions', cost_type: 'MATERIALS' },
      { code: 'FL-200', name: 'Installation labor', cost_type: installLabor },
      { code: 'FL-210', name: 'Floor prep and moisture remediation', cost_type: installLabor },
      { code: 'FL-300', name: 'Freight-in', cost_type: 'OTHER' },
    ],
    labor_rates: [
      { code: 'CPT_INSTALL', description: 'Carpet install', unit: 'SY', applies_to: 'FLOOR', sell_cents: 900, pay_cents: 550 },
      { code: 'LVP_INSTALL', description: 'LVP / laminate install', unit: 'SF', applies_to: 'FLOOR', sell_cents: 250, pay_cents: 140 },
      { code: 'TILE_INSTALL', description: 'Tile install', unit: 'SF', applies_to: 'FLOOR', sell_cents: 650, pay_cents: 400 },
      { code: 'STAIRS', description: 'Stair install', unit: 'STEP', applies_to: 'STAIRS', sell_cents: 1800, pay_cents: 1000 },
      { code: 'FLOOR_PREP', description: 'Floor prep / leveling', unit: 'SF', applies_to: 'PREP', sell_cents: 150, pay_cents: 90 },
      { code: 'MOISTURE', description: 'Moisture remediation', unit: 'SF', applies_to: 'PREP', sell_cents: 200, pay_cents: 110 },
      { code: 'TEAR_OUT', description: 'Tear-out and haul-off', unit: 'SF', applies_to: 'DEMO', sell_cents: 100, pay_cents: 60 },
      { code: 'FURNITURE', description: 'Furniture moving', unit: 'JOB', applies_to: 'MOVING', sell_cents: 15000, pay_cents: 8000 },
    ],
    books_accounts: {
      customer_deposits: 'Customer deposits (liability)',
      inventory_rolls: 'Inventory — roll goods',
      inventory_hard_surface: 'Inventory — hard surface',
      ...(mix.includes('CASH_AND_CARRY') ? { counter_sales: 'Sales — counter (cash and carry)' } : {}),
    },
  };
}
