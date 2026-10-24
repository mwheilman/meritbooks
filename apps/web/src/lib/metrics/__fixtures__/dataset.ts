/**
 * Test fixtures for the metric evaluator: compact builders for datasets and
 * companies (not a test file — vitest only runs *.test.ts).
 */

import { monthRange, type MonthKey } from '@/lib/analytics/months';
import { ACCOUNT_CLASS_KEYS } from '../classes';
import type { AccountClass, ClassMapping, CompanyDataset, MetricDataset, OperationalKey } from '../types';

export type Monthly = Partial<Record<MonthKey, number>>;

/** Same value every month in [from, to]. */
export function flat(from: MonthKey, to: MonthKey, cents: number): Monthly {
  const out: Monthly = {};
  for (const m of monthRange(from, to)) out[m] = cents;
  return out;
}

export interface CompanySpec {
  id: string;
  name?: string;
  first?: MonthKey | null;
  inGroupFrom?: MonthKey | null;
  ownershipPct?: number | null;
  closedThrough?: MonthKey | null;
  /** Monthly flows per class (class measure). */
  flows?: Partial<Record<AccountClass, Monthly>>;
  /** Opening balance (end of the month before rangeStart) per class. */
  opening?: Partial<Record<AccountClass, number>>;
  budget?: Partial<Record<AccountClass, Monthly>>;
  budgetApprovedFy?: number[];
  operational?: Partial<Record<OperationalKey, Monthly>>;
  customerRevenue?: Partial<Record<MonthKey, Record<string, number>>>;
  vendorSpend?: Partial<Record<MonthKey, Record<string, number>>>;
}

export function company(spec: CompanySpec): CompanyDataset {
  const gl: CompanyDataset['gl'] = {};
  const classes = new Set<AccountClass>([...(Object.keys(spec.flows ?? {}) as AccountClass[]), ...(Object.keys(spec.opening ?? {}) as AccountClass[])]);
  for (const cls of classes) gl[cls] = { opening: spec.opening?.[cls] ?? 0, months: { ...(spec.flows?.[cls] ?? {}) } };
  return {
    id: spec.id,
    name: spec.name ?? spec.id.toUpperCase(),
    ownershipPct: spec.ownershipPct === undefined ? null : spec.ownershipPct,
    inGroupFrom: spec.inGroupFrom ?? null,
    firstMonthOnFile: spec.first === undefined ? '2020-01' : spec.first,
    closedThrough: spec.closedThrough === undefined ? '2030-12' : spec.closedThrough,
    gl,
    budget: spec.budget ?? {},
    budgetApprovedFy: spec.budgetApprovedFy ?? [],
    operational: spec.operational ?? {},
    customerRevenue: spec.customerRevenue,
    vendorSpend: spec.vendorSpend,
  };
}

/** Every class mapped to one fake account unless listed in `unmapped`. */
export function mappingAll(unmapped: AccountClass[] = []): Partial<Record<AccountClass, ClassMapping>> {
  const out: Partial<Record<AccountClass, ClassMapping>> = {};
  for (const cls of ACCOUNT_CLASS_KEYS) if (!unmapped.includes(cls)) out[cls] = { accountIds: [`acct-${cls}`], via: ['type'] };
  return out;
}

export const ALL_OPERATIONAL: OperationalKey[] = [
  'ar_open', 'ar_current', 'ar_1_30', 'ar_31_60', 'ar_61_90', 'ar_over_90', 'credit_sales', 'customer_days_to_pay_weighted', 'customer_paid_amount',
  'ap_open', 'ap_current', 'ap_1_30', 'ap_31_60', 'ap_61_90', 'ap_over_90', 'purchases',
  'headcount', 'jobs_active', 'backlog', 'wip_underbillings', 'wip_overbillings', 'cost_to_complete', 'gp_in_backlog', 'job_contract_value', 'job_estimated_gp',
  'units_in_stock', 'unit_days_in_stock', 'units_aged', 'warranty_open', 'warranty_claimed', 'close_days', 'addbacks',
];

export function dataset(companies: CompanyDataset[], opts: Partial<Omit<MetricDataset, 'companies'>> = {}): MetricDataset {
  return {
    source: 'fixture',
    fyStartMonth: opts.fyStartMonth ?? 1,
    rangeStart: opts.rangeStart ?? '2020-01',
    latestMonth: opts.latestMonth ?? '2026-12',
    companies,
    classMapping: opts.classMapping ?? mappingAll(),
    operationalAvailable: opts.operationalAvailable ?? ALL_OPERATIONAL,
  };
}
