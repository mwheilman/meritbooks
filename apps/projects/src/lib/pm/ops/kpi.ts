/**
 * Pack KPIs from pm.v_kpis, formatted by the metric catalog's unit and sent somewhere the
 * number can be acted on. Pure (unit-tested). A KPI is never shown alone: it carries its
 * basis (window and sample) and, in a multi-company workspace, the other companies' values.
 */
import { compactMoney, count, money, pct } from '@meritbooks/merit-ui';
import { getMetric, type MetricUnit } from '@meritbooks/industry-packs/src/metrics';

/** Metrics the 1104–1107 views compute (the union in pm.v_kpis). */
export const VIEW_METRICS: ReadonlySet<string> = new Set([
  'first_time_fix_pct', 'callback_rate_pct', 'agreement_visits_overdue_count', 'agreement_renewal_pct', 'avg_ticket_cents',
  'revenue_per_tech_day_cents', 'billable_utilization_pct', 'ro_days_in_shop', 'warranty_claims_outstanding_cents',
  'warranty_rejection_rate_pct', 'tech_efficiency_pct', 'effective_labor_rate_cents',
  'shop_backlog_weeks', 'labor_efficiency_pct', 'remake_rate_pct', 'on_time_delivery_pct', 'material_yield_pct',
  'selections_on_time_pct', 'proposal_approval_days', 'items_overdue_count', 'product_margin_pct', 'installer_sqft_per_day', 'waste_variance_pct',
  'draw_cycle_days', 'in_balance_gap_cents', 'interest_reserve_months', 'contingency_burn_ratio',
]);

export function unitOf(metric: string): MetricUnit {
  return getMetric(metric)?.unit ?? 'count';
}

function decimal(n: number, d: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** "82.4%" · "1,240" (cents → whole dollars) · "3.4 days" · "1.6 weeks" · "1.18×" · "640 sq ft a day". */
export function formatKpi(metric: string, value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  switch (unitOf(metric)) {
    case 'pct': return pct(value);
    case 'cents': return Math.abs(value) >= 1_000_000 ? compactMoney(Math.round(value)) : money(Math.round(value), { decimals: 0 });
    case 'days': return `${decimal(value, 1)} ${value === 1 ? 'day' : 'days'}`;
    case 'weeks': return `${decimal(value, 1)} weeks`;
    case 'months': return `${decimal(value, 1)} months`;
    case 'ratio': return `${decimal(value, 2)}×`;
    case 'per_day': return `${count(value)} sq ft a day`;
    default: return count(value);
  }
}

/** What the sample counts, by metric family (for "over 42 visits"). */
function sampleNoun(metric: string, n: number): string {
  const one = n === 1;
  if (/^draw_|in_balance|interest_reserve|contingency/.test(metric)) return metric === 'draw_cycle_days' ? (one ? 'funded draw' : 'funded draws') : one ? 'loan' : 'loans';
  if (/warranty/.test(metric)) return one ? 'claim' : 'claims';
  if (/agreement/.test(metric)) return one ? 'agreement' : 'agreements';
  if (/ro_days|tech_efficiency|effective_labor/.test(metric)) return one ? 'repair order' : 'repair orders';
  if (/utilization/.test(metric)) return one ? 'time entry' : 'time entries';
  if (/shop_backlog|on_time|material_yield/.test(metric)) return one ? 'production order' : 'production orders';
  if (/labor_efficiency|remake/.test(metric)) return one ? 'operation' : 'operations';
  if (/selection|proposal/.test(metric)) return one ? 'decision' : 'decisions';
  if (/items_overdue|product_margin/.test(metric)) return one ? 'item' : 'items';
  if (/installer|waste/.test(metric)) return metric === 'installer_sqft_per_day' ? (one ? 'crew day' : 'crew days') : one ? 'order' : 'orders';
  if (/first_time_fix/.test(metric)) return one ? 'job' : 'jobs';
  if (/revenue_per_tech/.test(metric)) return one ? 'tech day' : 'tech days';
  return one ? 'visit' : 'visits';
}

/** The window the view uses for the metric. */
function windowOf(metric: string): string {
  if (['agreement_visits_overdue_count', 'warranty_claims_outstanding_cents', 'shop_backlog_weeks', 'items_overdue_count', 'in_balance_gap_cents', 'interest_reserve_months', 'contingency_burn_ratio'].includes(metric)) return 'today';
  if (metric === 'agreement_renewal_pct' || metric === 'draw_cycle_days') return 'last 12 months';
  return 'last 90 days';
}

/** "42 visits · last 90 days" */
export function basisLine(metric: string, sampleN: number): string {
  return `${count(sampleN)} ${sampleNoun(metric, sampleN)} · ${windowOf(metric)}`;
}

/** Where each metric is worked. */
export function kpiHref(metric: string): { href: string; label: string } {
  switch (metric) {
    case 'agreement_visits_overdue_count':
    case 'agreement_renewal_pct':
      return { href: '/agreements', label: 'Agreements' };
    case 'warranty_claims_outstanding_cents':
    case 'warranty_rejection_rate_pct':
      return { href: '/work-orders?view=claims', label: 'Warranty claims' };
    case 'ro_days_in_shop':
    case 'tech_efficiency_pct':
    case 'effective_labor_rate_cents':
    case 'first_time_fix_pct':
    case 'callback_rate_pct':
    case 'avg_ticket_cents':
      return { href: '/work-orders?band=complete', label: 'Completed work' };
    case 'revenue_per_tech_day_cents':
      return { href: '/dispatch', label: 'Dispatch board' };
    case 'billable_utilization_pct':
      return { href: '/time', label: 'Time' };
    case 'shop_backlog_weeks':
    case 'labor_efficiency_pct':
    case 'remake_rate_pct':
    case 'on_time_delivery_pct':
    case 'material_yield_pct':
      return { href: '/production', label: 'Production' };
    case 'selections_on_time_pct':
    case 'proposal_approval_days':
      return { href: '/selections', label: 'Selections' };
    case 'items_overdue_count':
    case 'product_margin_pct':
      return { href: '/selections?tab=items', label: 'Items' };
    case 'installer_sqft_per_day':
    case 'waste_variance_pct':
      return { href: '/selections?tab=measures', label: 'Measures' };
    case 'draw_cycle_days':
    case 'in_balance_gap_cents':
    case 'interest_reserve_months':
    case 'contingency_burn_ratio':
      return { href: '/draws', label: 'Draws' };
    default:
      return { href: '/jobs', label: 'Jobs' };
  }
}

/** Whether a value is on the good side of a threshold (used only for the attention mark). */
export function kpiAttention(metric: string, value: number | null): boolean {
  if (value == null) return false;
  if (metric === 'in_balance_gap_cents') return value > 0;
  if (metric === 'contingency_burn_ratio') return value > 1;
  if (metric === 'agreement_visits_overdue_count' || metric === 'items_overdue_count') return value > 0;
  if (metric === 'interest_reserve_months') return value < 3;
  return false;
}
