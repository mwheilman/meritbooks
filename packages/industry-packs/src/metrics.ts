/**
 * The closed Projects metric catalog. A pack KPI names a metric from this list; the app computes
 * it from the job, cost and billing read models. Adding a metric is an app change (a definition and
 * a query), never a pack change. Each definition is one line and says exactly what is counted.
 *
 * Units: pct (0..1 fraction), cents (integer money), days, weeks, months, hours, count, ratio.
 */

export type MetricUnit = 'pct' | 'cents' | 'days' | 'weeks' | 'months' | 'count' | 'ratio' | 'per_day';

export interface MetricDef {
  key: string;
  label: string;
  unit: MetricUnit;
  goodDirection: 'up' | 'down';
  definition: string;
}

const m = (key: string, label: string, unit: MetricUnit, goodDirection: 'up' | 'down', definition: string): MetricDef => ({
  key, label, unit, goodDirection, definition,
});

export const METRICS: readonly MetricDef[] = [
  // ---- margin and budget (all job-based packs)
  m('gross_margin_pct', 'Projected gross margin', 'pct', 'up', '(Revised contract − projected cost at completion) ÷ revised contract, per job and rolled up by revenue.'),
  m('margin_fade_pct', 'Margin fade', 'pct', 'up', 'Projected gross margin today minus gross margin in the accepted estimate; negative means the job is fading.'),
  m('budget_variance_pct', 'Budget variance', 'pct', 'down', '(Projected cost − revised budget) ÷ revised budget, summed over cost codes with work remaining.'),
  m('forecast_variance_cents', 'Forecast over budget', 'cents', 'down', 'Estimated cost at completion (committed + uncommitted + pending exposure) minus the revised budget.'),
  m('backlog_cents', 'Backlog', 'cents', 'up', 'Signed revised contract value not yet earned (contract − earned revenue) on open jobs.'),
  m('completed_unbilled_cents', 'Completed, not billed', 'cents', 'down', 'Contract value on jobs or visits in a complete stage that has no approved billing request yet.'),
  m('schedule_slip_days', 'Schedule slip', 'days', 'down', 'Forecast finish minus baseline finish of the last task, averaged over open jobs.'),
  m('cycle_time_days', 'Cycle time', 'days', 'down', 'Calendar days from first active stage to complete stage, median over jobs completed in the period.'),
  m('close_rate_pct', 'Close rate', 'pct', 'up', 'Estimates accepted ÷ estimates sent in the period, by count.'),

  // ---- contract billing (commercial, trades, ETO commercial)
  m('over_under_billing_cents', 'Over/under billing', 'cents', 'up', 'Billed to date minus earned revenue (percent complete × revised contract); negative is underbilled.'),
  m('pending_change_exposure_cents', 'Pending change exposure', 'cents', 'down', 'Value of change orders priced or proceeding but not yet approved by the customer.'),
  m('change_order_pct_of_contract', 'Change orders as % of contract', 'pct', 'up', 'Approved change order value ÷ original contract value.'),
  m('retainage_receivable_cents', 'Retainage receivable', 'cents', 'down', 'Retainage withheld on billed work that has not been released and billed.'),
  m('rfi_avg_days_open', 'RFI days open', 'days', 'down', 'Average age in days of open RFIs, counted from the date sent.'),
  m('compliance_expired_count', 'Expired compliance documents', 'count', 'down', 'Required COIs, licenses and lien waivers on active commitments that are expired or missing.'),
  m('labor_efficiency_pct', 'Labor efficiency', 'pct', 'up', 'Earned hours (budget hours × percent complete) ÷ actual hours, by cost code or operation.'),
  m('unbilled_tm_cents', 'Unbilled time and materials', 'cents', 'down', 'Approved T&M time, tickets and expenses at bill rates not yet on a billing request.'),

  // ---- residential
  m('selections_on_time_pct', 'Selections on time', 'pct', 'up', 'Selections approved on or before their due date ÷ selections due in the period.'),
  m('deposit_coverage_pct', 'Cash ahead of cost', 'pct', 'up', 'Cash received from the customer ÷ cost incurred to date, per open job.'),
  m('warranty_cost_pct', 'Warranty cost', 'pct', 'down', 'Warranty and callback cost in the period ÷ revenue from jobs completed in the trailing 12 months.'),

  // ---- field service
  m('avg_ticket_cents', 'Average ticket', 'cents', 'up', 'Billed revenue ÷ completed jobs with a charge, excluding recalls and $0 jobs.'),
  m('first_time_fix_pct', 'First-time fix', 'pct', 'up', 'Jobs completed in a single visit ÷ jobs completed.'),
  m('callback_rate_pct', 'Callbacks', 'pct', 'down', 'Recall or comeback jobs within 30 days on the same site or serial ÷ jobs completed.'),
  m('agreement_visits_overdue_count', 'Agreement visits overdue', 'count', 'down', 'Agreement visits past their due window that are not scheduled or completed.'),
  m('agreement_renewal_pct', 'Agreement renewals', 'pct', 'up', 'Agreements renewed ÷ agreements that reached their end date in the period.'),
  m('revenue_per_tech_day_cents', 'Revenue per tech day', 'cents', 'up', 'Billed revenue ÷ technician days worked (days with at least one completed visit).'),
  m('billable_utilization_pct', 'Billable utilization', 'pct', 'up', 'Billable hours ÷ paid hours, per person and rolled up.'),

  // ---- ETO manufacturing
  m('on_time_delivery_pct', 'On-time delivery', 'pct', 'up', 'Jobs delivered or shipped on or before the promised date ÷ jobs delivered.'),
  m('shop_backlog_weeks', 'Shop backlog', 'weeks', 'up', 'Estimated shop hours on released and sold jobs ÷ weekly shop capacity hours.'),
  m('material_yield_pct', 'Material yield', 'pct', 'up', 'Estimated sheet and stock usage ÷ actual usage issued to jobs.'),
  m('remake_rate_pct', 'Remakes', 'pct', 'down', 'Cost of remakes and rework ÷ production cost in the period.'),

  // ---- flooring
  m('material_margin_pct', 'Material margin', 'pct', 'up', '(Material revenue − material cost incl. freight-in) ÷ material revenue.'),
  m('labor_margin_pct', 'Labor margin', 'pct', 'up', '(Installation revenue − installer pay and labor cost) ÷ installation revenue.'),
  m('waste_variance_pct', 'Waste over estimate', 'pct', 'down', 'Actual material used ÷ material estimated (incl. planned waste) − 1, by product category.'),
  m('installer_sqft_per_day', 'Installed per crew day', 'per_day', 'up', 'Square feet installed ÷ installer crew days, by category.'),

  // ---- interior design
  m('product_margin_pct', 'Product margin', 'pct', 'up', '(Sell price − net cost − freight and receiving) ÷ sell price on delivered items.'),
  m('fee_realization_pct', 'Fee realization', 'pct', 'up', 'Fees billed ÷ (hours worked × standard rate).'),
  m('deposit_float_cents', 'Deposit float', 'cents', 'up', 'Client deposits held minus vendor deposits paid on open items.'),
  m('items_overdue_count', 'Items past due', 'count', 'down', 'Ordered items whose expected ship or delivery date has passed without a receipt.'),
  m('unbilled_reimbursables_cents', 'Unbilled reimbursables', 'cents', 'down', 'Freight, receiving, storage and travel costs on jobs not yet rebilled to the client.'),
  m('proposal_approval_days', 'Days to approve proposals', 'days', 'down', 'Median days from proposal sent to client approval.'),

  // ---- equipment dealer
  m('tech_efficiency_pct', 'Tech efficiency', 'pct', 'up', 'Flagged (billed) hours ÷ hours clocked on repair order lines.'),
  m('effective_labor_rate_cents', 'Effective labor rate', 'cents', 'up', 'Labor revenue ÷ hours clocked on repair order lines.'),
  m('ro_days_in_shop', 'Days in shop', 'days', 'down', 'Average days from check-in to ready for pickup on repair orders closed in the period.'),
  m('warranty_claims_outstanding_cents', 'Warranty claims outstanding', 'cents', 'down', 'Submitted manufacturer warranty claims not yet paid or written off.'),
  m('warranty_rejection_rate_pct', 'Warranty rejections', 'pct', 'down', 'Warranty claims rejected or written off ÷ claims decided in the period.'),
  m('unit_turn_days', 'Unit turn', 'days', 'down', 'Average days from received to delivered on dealer units delivered in the trailing 365 days.'),
  m('aged_inventory_count_over_180', 'Units over 180 days', 'count', 'down', 'Dealer units in stock, in PDI, on demo or on hold that were received more than 180 days ago.'),
  m('deal_gross_avg_cents', 'Average deal gross', 'cents', 'up', 'Average front plus back gross (pinned at delivery) on deals delivered in the trailing 90 days and not unwound.'),
  m('parts_fill_rate_pct', 'Parts fill rate', 'pct', 'up', 'Counter-ticket lines filled in full from stock ÷ all lines, on tickets closed in the trailing 90 days.'),
  m('rental_utilization_pct', 'Rental utilization', 'pct', 'up', 'Days on rent ÷ days available across the current rental fleet, trailing 90 days.'),

  // ---- real estate development
  m('contingency_burn_ratio', 'Contingency burn vs progress', 'ratio', 'down', 'Share of contingency used ÷ share of hard cost complete; above 1.0 means burning faster than building.'),
  m('draw_cycle_days', 'Draw cycle', 'days', 'down', 'Median days from draw submitted to the lender to draw funded.'),
  m('in_balance_gap_cents', 'Out-of-balance amount', 'cents', 'down', 'Cost to complete minus remaining loan and equity; above zero the project is out of balance.'),
  m('interest_reserve_months', 'Interest reserve runway', 'months', 'up', 'Remaining interest reserve ÷ projected monthly interest to completion.'),
  m('lien_waiver_compliance_pct', 'Lien waiver compliance', 'pct', 'up', 'Payments with the required conditional or unconditional waiver on file ÷ payments made.'),

  // ---- professional services
  m('effective_hourly_rate_cents', 'Effective hourly rate', 'cents', 'up', 'Fees billed ÷ hours worked, per project and rolled up.'),
];

export const METRIC_KEYS: readonly string[] = METRICS.map((x) => x.key);

const BY_KEY = new Map(METRICS.map((x) => [x.key, x]));

export function getMetric(key: string): MetricDef | undefined {
  return BY_KEY.get(key);
}

export function isMetricKey(key: string): boolean {
  return BY_KEY.has(key);
}
