/**
 * Built-in dashboard packs (AC-W1): Owner, CFO, Construction, Dealer, Practice. Every key is
 * a registry metric (guard test). The administrator publishes role defaults on top of these;
 * a role with no published default gets the pack for its role. PURE.
 */

import type { DashboardCard, DashboardSettings, PackKey } from './types';

export interface PackDef {
  key: Exclude<PackKey, 'custom'>;
  name: string;
  description: string;
  metrics: readonly string[];
  settings: DashboardSettings;
}

const YTD_PY: DashboardSettings = { basis: 'ytd', comparison: 'prior_year', sparkline: 12 };

export const PACKS: readonly PackDef[] = [
  {
    key: 'owner',
    name: 'Owner',
    description: 'How the year is going, the cash in the bank, and what it is worth: growth, margins, plan and cash.',
    settings: YTD_PY,
    metrics: ['revenue', 'revenue_growth_yoy', 'revenue_cagr_3y', 'gross_margin', 'ebitda', 'ebitda_margin', 'net_income', 'revenue_budget_variance', 'cash', 'cash_runway_months', 'dso', 'rule_of_40'],
  },
  {
    key: 'cfo',
    name: 'CFO',
    description: 'Profit against plan, cash conversion, working capital and the lender ratios.',
    settings: YTD_PY,
    metrics: [
      'revenue', 'gross_margin', 'ebitda', 'ebitda_margin', 'ebitda_budget_variance', 'opex_pct_revenue', 'operating_cash_flow', 'free_cash_flow', 'cash', 'days_cash_on_hand',
      'dso', 'dpo', 'cash_conversion_cycle', 'current_ratio', 'net_debt_to_ebitda', 'dscr', 'interest_coverage', 'covenant_headroom_min', 'revenue_per_employee', 'rule_of_40',
    ],
  },
  {
    key: 'construction',
    name: 'Construction',
    description: 'Backlog coverage, billings position, fade and retainage beside the core P&L.',
    settings: YTD_PY,
    metrics: ['revenue', 'gross_margin', 'backlog', 'months_of_backlog', 'gp_in_backlog', 'backlog_margin', 'net_over_under_billings', 'underbillings', 'overbillings', 'job_fade', 'wip_gl_variance', 'retainage_receivable', 'dso', 'cash'],
  },
  {
    key: 'dealer',
    name: 'Dealer',
    description: 'Units, days in stock, floor-plan exposure and warranty receivables beside margins.',
    settings: YTD_PY,
    metrics: ['revenue', 'gross_margin', 'units_in_stock', 'floor_plan_days', 'aged_units_pct', 'floor_plan_payable', 'floor_plan_coverage', 'warranty_receivable_days', 'dio', 'inventory_turnover', 'ebitda_margin', 'cash'],
  },
  {
    key: 'practice',
    name: 'Practice',
    description: 'Books health and client economics for an accounting practice: close speed, throughput, collections.',
    settings: { basis: 'month', comparison: 'prior_period', sparkline: 12 },
    metrics: ['close_cycle_days', 'items_per_bookkeeper', 'revenue', 'revenue_growth_yoy', 'gross_margin', 'ebitda_margin', 'dso', 'average_days_delinquent', 'ar_over_90_pct', 'revenue_per_employee', 'payroll_pct_revenue', 'cash'],
  },
];

export const PACK_BY_KEY: ReadonlyMap<string, PackDef> = new Map(PACKS.map((p) => [p.key, p]));

/** Trend-type metrics read better wide. */
const WIDE = new Set(['revenue', 'ebitda', 'cash', 'backlog']);

export function packCards(pack: PackDef): DashboardCard[] {
  return pack.metrics.map((metric) => ({ metric, size: WIDE.has(metric) ? 'm' : 's' }));
}

/**
 * The built-in pack for a role (UserRole vocabulary, lib/rbac/permissions.ts).
 * Leadership → Owner; finance staff → CFO; a practice / firm seat → Practice.
 */
export function packForRole(role: string | null | undefined): PackDef {
  const key = ((): PackDef['key'] => {
    switch (role) {
      case 'company_admin':
      case 'business_user':
        return 'owner';
      case 'cfo':
      case 'merit_controller':
      case 'assistant_cfo':
        return 'cfo';
      case 'accounting_manager':
      case 'accounting_specialist':
      case 'check_processor':
      case 'general_admin':
        return 'practice';
      default:
        return 'owner';
    }
  })();
  return PACK_BY_KEY.get(key) as PackDef;
}
