/**
 * Operational (non-GL) metric inputs: what each one means, how it aggregates across
 * companies and months, which sub-ledger supplies it, and what a card says when it is
 * missing.
 */

import type { CannotComputeReason, OperationalKey, Requirement } from './types';

export interface OperationalInputDef {
  key: OperationalKey;
  label: string;
  /** flow = summed over the window; balance = read at a month-end. */
  nature: 'flow' | 'balance';
  /** How companies combine: sum (× ownership weight); mean / max / min are unweighted. */
  aggregate: 'sum' | 'mean' | 'max' | 'min';
  requires: Requirement;
  /** Reason when a needed month has no value. */
  missing: CannotComputeReason;
  /** Plain-English "what is missing" for the message. */
  missingWhat: string;
  unit: 'money' | 'count' | 'days' | 'percent' | 'money_days';
  source: string;
}

const ar = (key: OperationalKey, label: string, nature: 'flow' | 'balance' = 'balance', unit: OperationalInputDef['unit'] = 'money'): OperationalInputDef => ({
  key,
  label,
  nature,
  aggregate: 'sum',
  requires: 'ar_subledger',
  missing: 'not_on_file',
  missingWhat: 'Receivables detail',
  unit,
  source: 'invoices',
});

const ap = (key: OperationalKey, label: string, nature: 'flow' | 'balance' = 'balance'): OperationalInputDef => ({
  key,
  label,
  nature,
  aggregate: 'sum',
  requires: 'ap_subledger',
  missing: 'not_on_file',
  missingWhat: 'Payables detail',
  unit: 'money',
  source: 'bills',
});

const job = (key: OperationalKey, label: string, unit: OperationalInputDef['unit'] = 'money'): OperationalInputDef => ({
  key,
  label,
  nature: 'balance',
  aggregate: 'sum',
  requires: 'jobs',
  missing: 'no_jobs',
  missingWhat: 'Job positions',
  unit,
  source: 'core.jobs',
});

const dealer = (key: OperationalKey, label: string, nature: 'flow' | 'balance', unit: OperationalInputDef['unit']): OperationalInputDef => ({
  key,
  label,
  nature,
  aggregate: 'sum',
  requires: 'dealer',
  missing: 'not_on_file',
  missingWhat: 'Dealer unit and warranty records',
  unit,
  source: key.startsWith('warranty') ? 'warranty_claims' : 'dealer_units',
});

export const OPERATIONAL_INPUTS: Record<OperationalKey, OperationalInputDef> = {
  ar_open: ar('ar_open', 'Open receivables'),
  ar_current: ar('ar_current', 'Receivables not yet due'),
  ar_1_30: ar('ar_1_30', 'Receivables 1–30 days past due'),
  ar_31_60: ar('ar_31_60', 'Receivables 31–60 days past due'),
  ar_61_90: ar('ar_61_90', 'Receivables 61–90 days past due'),
  ar_over_90: ar('ar_over_90', 'Receivables over 90 days past due'),
  credit_sales: ar('credit_sales', 'Invoiced sales', 'flow'),
  customer_days_to_pay_weighted: ar('customer_days_to_pay_weighted', 'Amount-weighted days to pay', 'flow', 'money_days'),
  customer_paid_amount: ar('customer_paid_amount', 'Invoices paid', 'flow'),
  ap_open: ap('ap_open', 'Open payables'),
  ap_current: ap('ap_current', 'Payables not yet due'),
  ap_1_30: ap('ap_1_30', 'Payables 1–30 days past due'),
  ap_31_60: ap('ap_31_60', 'Payables 31–60 days past due'),
  ap_61_90: ap('ap_61_90', 'Payables 61–90 days past due'),
  ap_over_90: ap('ap_over_90', 'Payables over 90 days past due'),
  purchases: ap('purchases', 'Bills entered', 'flow'),
  discounts_offered: { ...ap('discounts_offered', 'Early-pay discounts offered', 'flow'), requires: 'ap_discounts', missingWhat: 'Early-pay discount terms' },
  discounts_taken: { ...ap('discounts_taken', 'Early-pay discounts taken', 'flow'), requires: 'ap_discounts', missingWhat: 'Early-pay discount terms' },
  headcount: {
    key: 'headcount',
    label: 'Headcount',
    nature: 'balance',
    aggregate: 'sum',
    requires: 'headcount',
    missing: 'not_on_file',
    missingWhat: 'Headcount',
    unit: 'count',
    source: 'payroll_run_employees',
  },
  jobs_active: job('jobs_active', 'Active jobs', 'count'),
  backlog: job('backlog', 'Backlog (signed, unearned contract revenue)'),
  wip_underbillings: job('wip_underbillings', 'Underbillings (WIP schedule)'),
  wip_overbillings: job('wip_overbillings', 'Overbillings (WIP schedule)'),
  cost_to_complete: job('cost_to_complete', 'Estimated cost to complete'),
  gp_in_backlog: job('gp_in_backlog', 'Gross profit in backlog'),
  job_contract_value: job('job_contract_value', 'Contract value of active jobs'),
  job_estimated_gp: job('job_estimated_gp', 'Estimated gross profit of active jobs'),
  job_fade: { ...job('job_fade', 'Fade (bid GP − current estimated GP)'), missing: 'not_on_file', missingWhat: 'Original bid cost estimates' },
  units_in_stock: dealer('units_in_stock', 'Units in stock', 'balance', 'count'),
  unit_days_in_stock: dealer('unit_days_in_stock', 'Unit-days in stock', 'balance', 'days'),
  units_aged: dealer('units_aged', 'Units in stock over 180 days', 'balance', 'count'),
  warranty_open: dealer('warranty_open', 'Open warranty claims', 'balance', 'money'),
  warranty_claimed: dealer('warranty_claimed', 'Warranty claims submitted', 'flow', 'money'),
  close_days: {
    key: 'close_days',
    label: 'Days from month end to hard close',
    nature: 'balance',
    aggregate: 'mean',
    requires: 'practice',
    missing: 'not_on_file',
    missingWhat: 'A hard-closed period',
    unit: 'days',
    source: 'fiscal_periods',
  },
  items_processed: {
    key: 'items_processed',
    label: 'Items processed',
    nature: 'flow',
    aggregate: 'sum',
    requires: 'practice',
    missing: 'not_on_file',
    missingWhat: 'Bookkeeping throughput',
    unit: 'count',
    source: 'bank_transactions',
  },
  bookkeepers: {
    key: 'bookkeepers',
    label: 'Bookkeepers',
    nature: 'balance',
    aggregate: 'sum',
    requires: 'practice',
    missing: 'not_on_file',
    missingWhat: 'Bookkeeper assignments',
    unit: 'count',
    source: 'core.memberships',
  },
  addbacks: {
    key: 'addbacks',
    label: 'Documented add-backs',
    nature: 'flow',
    aggregate: 'sum',
    requires: 'addbacks',
    missing: 'not_on_file',
    missingWhat: 'An add-back schedule',
    unit: 'money',
    source: 'addback schedule',
  },
  covenant_min_headroom: {
    key: 'covenant_min_headroom',
    label: 'Minimum covenant headroom',
    nature: 'balance',
    aggregate: 'min',
    requires: 'covenants',
    missing: 'not_on_file',
    missingWhat: 'Covenant measurements',
    unit: 'percent',
    source: 'covenants',
  },
};
