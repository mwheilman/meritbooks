/**
 * Metric registry — the KPI catalog (Wave 3B, FPB-reports-fpna §1.15 / §1.15a).
 *
 * Every entry is a typed expression over account CLASSES (resolved by role, never by
 * number), sub-ledger inputs and other metrics. The (i) formula string is generated
 * from the same tree (`formulaOf`). Units are stated in presentation terms: percent
 * metrics evaluate to a fraction and display ×100; money is integer cents.
 *
 * Benchmarks are optional, editable defaults with their source named; tenants and
 * Wave 6 benchmark data will override them.
 */

import {
  add,
  bal,
  budget,
  cagrOf,
  concentration,
  days,
  div,
  fallback,
  flow,
  formatExpr,
  growth,
  k,
  metric,
  mul,
  onBasis,
  opIn,
  positive,
  shift,
  sub,
} from './expr';
import type { Audience, Expr, MetricDefinition } from './types';

const ALL: Audience[] = ['owner', 'cfo', 'controller'];
const FIN: Audience[] = ['cfo', 'controller'];
const LENDER: Audience[] = ['cfo', 'lender', 'owner'];

const EDITABLE = 'MeritBooks default target (editable per tenant)';
const LENDING = 'Common commercial-lending covenant levels (editable per tenant)';

type Def = Omit<MetricDefinition, 'period' | 'requires' | 'audiences'> & {
  period?: Partial<MetricDefinition['period']>;
  requires?: MetricDefinition['requires'];
  audiences?: Audience[];
};

function d(x: Def): MetricDefinition {
  return {
    ...x,
    period: { nature: x.period?.nature ?? 'flow', basis: x.period?.basis ?? 'request' },
    requires: x.requires ?? ['gl'],
    audiences: x.audiences ?? ALL,
  };
}

const rev = flow('revenue');
const pctOfRevenue = (e: Expr): Expr => div(e, rev, 'positive');
const daysOf = (balance: Expr, flowExpr: Expr): Expr => mul(div(balance, flowExpr, 'positive'), days());
const ttm = (e: Expr): Expr => onBasis(e, 'ttm');
const shareOf = (part: Expr, whole: Expr): Expr => div(part, whole, 'positive');
const notBurning = 'the business is generating cash, so there is no runway to count down';

const DEFINITIONS: MetricDefinition[] = [
  // ── Revenue, profit, EBITDA ──────────────────────────────────────────────
  d({ key: 'revenue', name: 'Revenue', group: 'profitability', definition: 'Total revenue recognised in the period, from every revenue account.', formula: rev, unit: 'money', direction: 'higher_better', audiences: [...ALL, 'lender', 'construction', 'dealer', 'practice'] }),
  d({ key: 'cogs', name: 'Cost of revenue', group: 'profitability', definition: 'Direct costs of delivering the revenue (all cost-of-goods-sold accounts).', formula: flow('cogs'), unit: 'money', direction: 'lower_better' }),
  d({ key: 'gross_profit', name: 'Gross profit', group: 'profitability', definition: 'Revenue less cost of revenue.', formula: sub(rev, flow('cogs')), unit: 'money', direction: 'higher_better', audiences: [...ALL, 'construction', 'dealer'] }),
  d({ key: 'gross_margin', name: 'Gross margin', group: 'profitability', definition: 'Gross profit as a share of revenue. Changes are shown in percentage points.', formula: pctOfRevenue(metric('gross_profit')), unit: 'percent', direction: 'higher_better', audiences: [...ALL, 'construction', 'dealer'] }),
  d({ key: 'cogs_pct_revenue', name: 'Cost of revenue % of revenue', group: 'profitability', definition: 'Cost of revenue as a share of revenue.', formula: pctOfRevenue(flow('cogs')), unit: 'percent', direction: 'lower_better' }),
  d({ key: 'opex', name: 'Operating expenses', group: 'profitability', definition: 'All operating-expense accounts, including any depreciation booked in operating expenses.', formula: flow('opex'), unit: 'money', direction: 'lower_better' }),
  d({ key: 'opex_pct_revenue', name: 'Opex % of revenue', group: 'profitability', definition: 'Operating expenses as a share of revenue.', formula: pctOfRevenue(flow('opex')), unit: 'percent', direction: 'lower_better' }),
  d({ key: 'sga', name: 'SG&A', group: 'profitability', definition: 'Selling, general and administrative cost: operating expenses before depreciation and amortization.', formula: sub(flow('opex'), flow('da_opex')), unit: 'money', direction: 'lower_better' }),
  d({ key: 'sga_pct_revenue', name: 'SG&A % of revenue', group: 'profitability', definition: 'SG&A as a share of revenue.', formula: pctOfRevenue(metric('sga')), unit: 'percent', direction: 'lower_better' }),
  d({ key: 'operating_income', name: 'Operating income (EBIT)', group: 'profitability', definition: 'Gross profit less operating expenses, before other income and expense.', formula: sub(metric('gross_profit'), flow('opex')), unit: 'money', direction: 'higher_better' }),
  d({ key: 'operating_margin', name: 'Operating margin', group: 'profitability', definition: 'Operating income as a share of revenue.', formula: pctOfRevenue(metric('operating_income')), unit: 'percent', direction: 'higher_better' }),
  d({ key: 'depreciation_amortization', name: 'Depreciation & amortization', group: 'profitability', definition: 'Depreciation and amortization charged anywhere in the income statement.', formula: flow('da_total'), unit: 'money', direction: 'neutral', audiences: FIN }),
  d({ key: 'ebitda', name: 'EBITDA', group: 'profitability', definition: 'Operating income plus the depreciation and amortization inside operating costs. Computed from account roles, never typed in.', formula: add(metric('operating_income'), flow('da_operating')), unit: 'money', direction: 'higher_better', audiences: [...ALL, 'lender'] }),
  d({ key: 'ebitda_margin', name: 'EBITDA margin', group: 'profitability', definition: 'EBITDA as a share of revenue.', formula: pctOfRevenue(metric('ebitda')), unit: 'percent', direction: 'higher_better', audiences: [...ALL, 'lender'] }),
  d({ key: 'addbacks', name: 'EBITDA add-backs', group: 'profitability', definition: 'Documented, one-time or non-recurring items added back to EBITDA (each with a reason), such as owner-compensation normalisation.', formula: opIn('addbacks'), unit: 'money', direction: 'neutral', requires: ['addbacks'], audiences: [...FIN, 'lender'] }),
  d({
    key: 'adjusted_ebitda',
    name: 'Adjusted EBITDA',
    group: 'profitability',
    definition: 'EBITDA plus documented add-backs. With no add-back schedule on file it equals EBITDA, and says so.',
    formula: add(metric('ebitda'), fallback(metric('addbacks'), 0, ['not_on_file'], 'No add-backs on file, so adjusted EBITDA equals EBITDA.')),
    unit: 'money',
    direction: 'higher_better',
    requires: ['gl', 'addbacks'],
    audiences: [...ALL, 'lender'],
  }),
  d({ key: 'adjusted_ebitda_margin', name: 'Adjusted EBITDA margin', group: 'profitability', definition: 'Adjusted EBITDA as a share of revenue.', formula: pctOfRevenue(metric('adjusted_ebitda')), unit: 'percent', direction: 'higher_better', requires: ['gl', 'addbacks'], audiences: [...FIN, 'lender'] }),
  d({ key: 'other_income_net', name: 'Other income (expense), net', group: 'profitability', definition: 'Other income less other expense (interest, gains and losses, income tax and similar below-the-line items).', formula: sub(flow('other_income'), flow('other_expense')), unit: 'money', direction: 'higher_better', audiences: FIN }),
  d({ key: 'net_income', name: 'Net income', group: 'profitability', definition: 'Operating income plus other income less other expense.', formula: add(metric('operating_income'), metric('other_income_net')), unit: 'money', direction: 'higher_better', audiences: [...ALL, 'lender'] }),
  d({ key: 'net_margin', name: 'Net margin', group: 'profitability', definition: 'Net income as a share of revenue.', formula: pctOfRevenue(metric('net_income')), unit: 'percent', direction: 'higher_better' }),
  d({ key: 'contribution_margin', name: 'Contribution margin', group: 'profitability', definition: 'Revenue less cost of revenue and variable operating costs (merchant fees, commissions, freight, fuel, subcontract). Where no variable operating accounts exist it equals gross profit.', formula: sub(rev, add(flow('cogs'), flow('variable_opex'))), unit: 'money', direction: 'higher_better', audiences: ['owner', 'cfo'] }),
  d({ key: 'contribution_margin_pct', name: 'Contribution margin %', group: 'profitability', definition: 'Contribution margin as a share of revenue.', formula: pctOfRevenue(metric('contribution_margin')), unit: 'percent', direction: 'higher_better', audiences: ['owner', 'cfo'] }),
  d({ key: 'payroll_expense', name: 'Payroll & benefits', group: 'efficiency', definition: 'Wages, payroll taxes and employer benefits across cost of revenue and operating expenses.', formula: flow('payroll_expense'), unit: 'money', direction: 'neutral' }),
  d({ key: 'payroll_pct_revenue', name: 'Labour cost % of revenue', group: 'efficiency', definition: 'Payroll and benefits as a share of revenue.', formula: pctOfRevenue(flow('payroll_expense')), unit: 'percent', direction: 'lower_better', audiences: [...ALL, 'construction', 'practice'] }),
  d({ key: 'interest_expense', name: 'Interest expense', group: 'leverage', definition: 'Interest charged on borrowings, including floor-plan interest.', formula: flow('interest_expense'), unit: 'money', direction: 'lower_better', audiences: [...FIN, 'lender', 'dealer'] }),
  d({ key: 'effective_tax_rate', name: 'Effective tax rate', group: 'profitability', definition: 'Income tax expense as a share of pre-tax income.', formula: div(flow('income_tax_expense'), add(metric('net_income'), flow('income_tax_expense')), 'positive'), unit: 'percent', direction: 'neutral', audiences: FIN }),

  // ── Growth ────────────────────────────────────────────────────────────────
  d({ key: 'revenue_growth_yoy', name: 'Revenue growth (YoY)', group: 'growth', definition: 'Revenue for the period against the same period a year earlier.', formula: growth(rev, 12), unit: 'percent', direction: 'higher_better', audiences: [...ALL, 'lender'] }),
  d({ key: 'revenue_growth_mom', name: 'Revenue growth (MoM)', group: 'growth', definition: 'Revenue for the month against the month before.', formula: growth(rev, 1), unit: 'percent', direction: 'higher_better', period: { basis: 'month' } }),
  d({ key: 'gross_profit_growth_yoy', name: 'Gross profit growth (YoY)', group: 'growth', definition: 'Gross profit against the same period a year earlier.', formula: growth(metric('gross_profit'), 12), unit: 'percent', direction: 'higher_better' }),
  d({ key: 'ebitda_growth_yoy', name: 'EBITDA growth (YoY)', group: 'growth', definition: 'EBITDA against the same period a year earlier. Not meaningful when either year is a loss.', formula: growth(metric('ebitda'), 12), unit: 'percent', direction: 'higher_better' }),
  d({ key: 'opex_growth_yoy', name: 'Opex growth (YoY)', group: 'growth', definition: 'Operating expenses against the same period a year earlier.', formula: growth(flow('opex'), 12), unit: 'percent', direction: 'lower_better', audiences: FIN }),
  d({ key: 'revenue_cagr_1y', name: 'Revenue CAGR (1 year)', group: 'growth', definition: 'Trailing-twelve-month revenue against the trailing twelve months a year earlier.', formula: cagrOf(rev, 1), unit: 'percent', direction: 'higher_better', period: { basis: 'ttm' } }),
  d({ key: 'revenue_cagr_3y', name: 'Revenue CAGR (3 years)', group: 'growth', definition: 'Compound annual growth of trailing-twelve-month revenue over three years (TTM to TTM, which removes seasonality).', formula: cagrOf(rev, 3), unit: 'percent', direction: 'higher_better', period: { basis: 'ttm' } }),
  d({ key: 'revenue_cagr_5y', name: 'Revenue CAGR (5 years)', group: 'growth', definition: 'Compound annual growth of trailing-twelve-month revenue over five years (TTM to TTM).', formula: cagrOf(rev, 5), unit: 'percent', direction: 'higher_better', period: { basis: 'ttm' } }),
  d({ key: 'ebitda_cagr_1y', name: 'EBITDA CAGR (1 year)', group: 'growth', definition: 'Trailing-twelve-month EBITDA against a year earlier. Not meaningful through a loss.', formula: cagrOf(metric('ebitda'), 1), unit: 'percent', direction: 'higher_better', period: { basis: 'ttm' } }),
  d({ key: 'ebitda_cagr_3y', name: 'EBITDA CAGR (3 years)', group: 'growth', definition: 'Compound annual growth of trailing-twelve-month EBITDA over three years.', formula: cagrOf(metric('ebitda'), 3), unit: 'percent', direction: 'higher_better', period: { basis: 'ttm' } }),
  d({ key: 'ebitda_cagr_5y', name: 'EBITDA CAGR (5 years)', group: 'growth', definition: 'Compound annual growth of trailing-twelve-month EBITDA over five years.', formula: cagrOf(metric('ebitda'), 5), unit: 'percent', direction: 'higher_better', period: { basis: 'ttm' } }),

  // ── Plan (approved budget only) ───────────────────────────────────────────
  d({ key: 'revenue_budget_variance', name: 'Revenue vs budget', group: 'plan', definition: 'Actual revenue less approved-budget revenue for the same period.', formula: sub(rev, budget('revenue')), unit: 'money', direction: 'higher_better', requires: ['gl', 'budget'] }),
  d({ key: 'revenue_budget_attainment', name: 'Revenue attainment', group: 'plan', definition: 'Actual revenue as a share of approved-budget revenue.', formula: div(rev, budget('revenue'), 'positive'), unit: 'percent', direction: 'higher_better', requires: ['gl', 'budget'] }),
  d({ key: 'gross_profit_budget_variance', name: 'Gross profit vs budget', group: 'plan', definition: 'Actual gross profit less budgeted gross profit.', formula: sub(metric('gross_profit'), sub(budget('revenue'), budget('cogs'))), unit: 'money', direction: 'higher_better', requires: ['gl', 'budget'] }),
  d({ key: 'opex_budget_variance', name: 'Opex vs budget', group: 'plan', definition: 'Actual operating expenses less budgeted operating expenses (positive = overspend).', formula: sub(flow('opex'), budget('opex')), unit: 'money', direction: 'lower_better', requires: ['gl', 'budget'] }),
  d({
    key: 'ebitda_budget_variance',
    name: 'EBITDA vs budget',
    group: 'plan',
    definition: 'Actual EBITDA less budgeted EBITDA.',
    formula: sub(metric('ebitda'), add(sub(sub(budget('revenue'), budget('cogs')), budget('opex')), budget('da_operating'))),
    unit: 'money',
    direction: 'higher_better',
    requires: ['gl', 'budget'],
  }),

  // ── Cash & liquidity ──────────────────────────────────────────────────────
  d({ key: 'cash', name: 'Cash', group: 'liquidity', definition: 'Cash in bank and on hand at the end of the period.', formula: bal('cash'), unit: 'money', direction: 'higher_better', period: { nature: 'balance' }, audiences: [...ALL, 'lender', 'construction', 'dealer'] }),
  d({ key: 'working_capital', name: 'Working capital', group: 'liquidity', definition: 'Current assets less current liabilities at the end of the period.', formula: sub(bal('current_assets'), bal('current_liabilities')), unit: 'money', direction: 'higher_better', period: { nature: 'balance' }, audiences: [...ALL, 'lender', 'construction'] }),
  d({ key: 'working_capital_pct_revenue', name: 'Working capital % of revenue', group: 'liquidity', definition: 'Working capital as a share of trailing-twelve-month revenue (the M&A working-capital peg view).', formula: div(metric('working_capital'), ttm(rev), 'positive'), unit: 'percent', direction: 'neutral', period: { nature: 'mixed', basis: 'ttm' }, audiences: FIN }),
  d({
    key: 'current_ratio',
    name: 'Current ratio',
    group: 'liquidity',
    definition: 'Current assets divided by current liabilities.',
    formula: div(bal('current_assets'), bal('current_liabilities')),
    unit: 'ratio',
    direction: 'higher_better',
    period: { nature: 'balance' },
    audiences: [...ALL, 'lender', 'construction'],
    benchmark: { source: LENDING, bands: [{ label: 'Comfortable', min: 1.5, tone: 'good' }, { label: 'Tight', min: 1, max: 1.5, tone: 'watch' }, { label: 'Below 1', max: 1, tone: 'poor' }] },
  }),
  d({
    key: 'quick_ratio',
    name: 'Quick ratio',
    group: 'liquidity',
    definition: 'Cash plus receivables divided by current liabilities (excludes inventory and prepaids).',
    formula: div(add(bal('cash'), bal('ar')), bal('current_liabilities')),
    unit: 'ratio',
    direction: 'higher_better',
    period: { nature: 'balance' },
    audiences: [...FIN, 'lender'],
    benchmark: { source: LENDING, bands: [{ label: 'Comfortable', min: 1, tone: 'good' }, { label: 'Tight', min: 0.7, max: 1, tone: 'watch' }, { label: 'Weak', max: 0.7, tone: 'poor' }] },
  }),
  d({ key: 'cash_ratio', name: 'Cash ratio', group: 'liquidity', definition: 'Cash divided by current liabilities.', formula: div(bal('cash'), bal('current_liabilities')), unit: 'ratio', direction: 'higher_better', period: { nature: 'balance' }, audiences: [...FIN, 'lender'] }),
  d({ key: 'net_burn', name: 'Net cash burn (3-month average)', group: 'liquidity', definition: 'Average monthly fall in cash over the last three months. Negative means cash is growing.', formula: div(sub(shift(bal('cash'), 3), bal('cash')), k(3, '3 months')), unit: 'money', direction: 'lower_better', period: { nature: 'balance' }, audiences: ['owner', 'cfo'] }),
  d({ key: 'cash_runway_months', name: 'Cash runway', group: 'liquidity', definition: 'Months until cash runs out at the current 3-month average burn. Not meaningful while cash is growing.', formula: div(bal('cash'), positive(metric('net_burn'), notBurning), 'positive'), unit: 'months', direction: 'higher_better', period: { nature: 'balance' }, audiences: ['owner', 'cfo'] }),
  d({ key: 'days_cash_on_hand', name: 'Days cash on hand', group: 'liquidity', definition: 'Cash divided by average daily cash operating costs (cost of revenue plus operating expenses, less D&A).', formula: div(bal('cash'), div(sub(add(flow('cogs'), flow('opex')), flow('da_operating')), days(), 'positive'), 'positive'), unit: 'days', direction: 'higher_better', period: { nature: 'mixed' }, audiences: [...ALL, 'lender'] }),
  d({
    key: 'operating_cash_flow',
    name: 'Operating cash flow',
    group: 'liquidity',
    definition: 'Indirect method from the GL: net income plus D&A, less the increase in non-cash working capital (current assets other than cash, less current liabilities).',
    formula: sub(
      add(metric('net_income'), flow('da_total')),
      sub(
        sub(sub(bal('current_assets'), bal('cash')), bal('current_liabilities')),
        sub(sub(bal('current_assets', 'start'), bal('cash', 'start')), bal('current_liabilities', 'start')),
      ),
    ),
    unit: 'money',
    direction: 'higher_better',
    period: { nature: 'mixed' },
    audiences: [...FIN, 'lender'],
  }),
  d({ key: 'capex', name: 'Capital expenditure', group: 'liquidity', definition: 'Additions to fixed assets (gross debits to fixed-asset accounts, excluding accumulated depreciation).', formula: flow('capex'), unit: 'money', direction: 'neutral', audiences: [...FIN, 'lender'] }),
  d({ key: 'free_cash_flow', name: 'Free cash flow', group: 'liquidity', definition: 'Operating cash flow less capital expenditure.', formula: sub(metric('operating_cash_flow'), metric('capex')), unit: 'money', direction: 'higher_better', period: { nature: 'mixed' }, audiences: [...ALL, 'lender'] }),
  d({ key: 'fcf_conversion', name: 'FCF conversion', group: 'liquidity', definition: 'Free cash flow as a share of EBITDA — how much of the profit turns into cash.', formula: div(metric('free_cash_flow'), metric('ebitda'), 'positive'), unit: 'percent', direction: 'higher_better', period: { nature: 'mixed' }, audiences: [...FIN, 'lender'] }),

  // ── Working capital & receivables ─────────────────────────────────────────
  d({ key: 'dso', name: 'DSO (days sales outstanding)', group: 'working_capital', definition: 'Receivables at period end divided by revenue for the period, times the days in the period.', formula: daysOf(bal('ar'), rev), unit: 'days', direction: 'lower_better', period: { nature: 'mixed' }, audiences: [...ALL, 'lender', 'construction', 'practice'] }),
  d({ key: 'best_possible_dso', name: 'Best-possible DSO', group: 'receivables', definition: 'Receivables not yet due divided by invoiced sales, times the days in the period — the DSO if every customer paid on time.', formula: daysOf(opIn('ar_current'), opIn('credit_sales')), unit: 'days', direction: 'lower_better', period: { nature: 'mixed' }, requires: ['ar_subledger'], audiences: FIN }),
  d({ key: 'average_days_delinquent', name: 'Average days delinquent', group: 'receivables', definition: 'DSO less best-possible DSO on the receivables ledger: past-due receivables divided by invoiced sales, times the days in the period.', formula: daysOf(sub(opIn('ar_open'), opIn('ar_current')), opIn('credit_sales')), unit: 'days', direction: 'lower_better', period: { nature: 'mixed' }, requires: ['ar_subledger'], audiences: FIN }),
  d({
    key: 'collection_effectiveness_index',
    name: 'Collection effectiveness index (CEI)',
    group: 'receivables',
    definition: 'Share of collectible receivables actually collected: (opening AR + invoiced sales − closing AR) ÷ (opening AR + invoiced sales − closing current AR).',
    formula: div(
      sub(add(opIn('ar_open', { at: 'start' }), opIn('credit_sales')), opIn('ar_open')),
      sub(add(opIn('ar_open', { at: 'start' }), opIn('credit_sales')), opIn('ar_current')),
      'positive',
    ),
    unit: 'percent',
    direction: 'higher_better',
    period: { nature: 'mixed' },
    requires: ['ar_subledger'],
    audiences: FIN,
    benchmark: { source: 'Credit Research Foundation (median ≈ 79% in Q1 2025)', bands: [{ label: 'Excellent', min: 90, tone: 'good' }, { label: 'Fair', min: 70, max: 90, tone: 'watch' }, { label: 'Problem', max: 70, tone: 'poor' }] },
  }),
  d({ key: 'ar_turnover', name: 'Receivables turnover', group: 'receivables', definition: 'Trailing-twelve-month revenue divided by average receivables.', formula: div(rev, bal('ar', 'average'), 'positive'), unit: 'times', direction: 'higher_better', period: { nature: 'mixed', basis: 'ttm' }, audiences: FIN }),
  d({ key: 'ar_current_pct', name: 'Receivables current %', group: 'receivables', definition: 'Share of open receivables not yet due.', formula: shareOf(opIn('ar_current'), opIn('ar_open')), unit: 'percent', direction: 'higher_better', period: { nature: 'balance' }, requires: ['ar_subledger'], audiences: [...FIN, 'practice'] }),
  d({ key: 'ar_1_30_pct', name: 'Receivables 1–30 days past due %', group: 'receivables', definition: 'Share of open receivables 1–30 days past due.', formula: shareOf(opIn('ar_1_30'), opIn('ar_open')), unit: 'percent', direction: 'lower_better', period: { nature: 'balance' }, requires: ['ar_subledger'], audiences: FIN }),
  d({ key: 'ar_31_60_pct', name: 'Receivables 31–60 days past due %', group: 'receivables', definition: 'Share of open receivables 31–60 days past due.', formula: shareOf(opIn('ar_31_60'), opIn('ar_open')), unit: 'percent', direction: 'lower_better', period: { nature: 'balance' }, requires: ['ar_subledger'], audiences: FIN }),
  d({ key: 'ar_61_90_pct', name: 'Receivables 61–90 days past due %', group: 'receivables', definition: 'Share of open receivables 61–90 days past due.', formula: shareOf(opIn('ar_61_90'), opIn('ar_open')), unit: 'percent', direction: 'lower_better', period: { nature: 'balance' }, requires: ['ar_subledger'], audiences: FIN }),
  d({ key: 'ar_over_90_pct', name: 'Receivables over 90 days %', group: 'receivables', definition: 'Share of open receivables more than 90 days past due.', formula: shareOf(opIn('ar_over_90'), opIn('ar_open')), unit: 'percent', direction: 'lower_better', period: { nature: 'balance' }, requires: ['ar_subledger'], audiences: [...ALL, 'lender'], benchmark: { source: EDITABLE, bands: [{ label: 'Healthy', max: 5, tone: 'good' }, { label: 'Watch', min: 5, max: 15, tone: 'watch' }, { label: 'High', min: 15, tone: 'poor' }] } }),
  d({ key: 'average_days_to_pay', name: 'Average days to pay (customers)', group: 'receivables', definition: 'Amount-weighted days from invoice date to payment, for invoices paid in the period.', formula: div(opIn('customer_days_to_pay_weighted'), opIn('customer_paid_amount'), 'positive'), unit: 'days', direction: 'lower_better', requires: ['ar_subledger'], audiences: FIN }),
  d({ key: 'top_customer_concentration', name: 'Largest customer share of revenue', group: 'receivables', definition: "The largest customer's share of invoiced revenue in the period. Lenders flag any customer over 10%.", formula: concentration('customer_revenue', 'top1'), unit: 'percent', direction: 'lower_better', requires: ['ar_subledger'], audiences: [...ALL, 'lender'], benchmark: { source: 'Lender practice: any customer over 10% of revenue is flagged', bands: [{ label: 'Diversified', max: 10, tone: 'good' }, { label: 'Concentrated', min: 10, max: 25, tone: 'watch' }, { label: 'Dependent', min: 25, tone: 'poor' }] } }),
  d({ key: 'top5_customer_concentration', name: 'Top 5 customers share of revenue', group: 'receivables', definition: "The five largest customers' share of invoiced revenue in the period.", formula: concentration('customer_revenue', 'top5'), unit: 'percent', direction: 'lower_better', requires: ['ar_subledger'], audiences: [...FIN, 'lender'] }),
  d({ key: 'customer_hhi', name: 'Customer concentration index (HHI)', group: 'receivables', definition: 'Herfindahl-Hirschman index of revenue by customer, 0–10,000 (sum of squared percentage shares).', formula: concentration('customer_revenue', 'hhi'), unit: 'count', direction: 'lower_better', requires: ['ar_subledger'], audiences: [...FIN, 'lender'], benchmark: { source: 'US DOJ/FTC horizontal merger guidelines (2010) bands', bands: [{ label: 'Unconcentrated', max: 1500, tone: 'good' }, { label: 'Moderate', min: 1500, max: 2500, tone: 'watch' }, { label: 'High', min: 2500, tone: 'poor' }] } }),

  // ── Payables ──────────────────────────────────────────────────────────────
  d({ key: 'dpo', name: 'DPO (days payables outstanding)', group: 'working_capital', definition: 'Payables at period end divided by cost of revenue for the period, times the days in the period.', formula: daysOf(bal('ap'), flow('cogs')), unit: 'days', direction: 'higher_better', period: { nature: 'mixed' }, audiences: [...ALL, 'practice'] }),
  d({ key: 'ap_turnover', name: 'Payables turnover', group: 'payables', definition: 'Trailing-twelve-month cost of revenue divided by average payables.', formula: div(flow('cogs'), bal('ap', 'average'), 'positive'), unit: 'times', direction: 'neutral', period: { nature: 'mixed', basis: 'ttm' }, audiences: FIN }),
  d({ key: 'ap_current_pct', name: 'Payables current %', group: 'payables', definition: 'Share of open payables not yet due.', formula: shareOf(opIn('ap_current'), opIn('ap_open')), unit: 'percent', direction: 'higher_better', period: { nature: 'balance' }, requires: ['ap_subledger'], audiences: [...FIN, 'practice'] }),
  d({ key: 'ap_over_90_pct', name: 'Payables over 90 days %', group: 'payables', definition: 'Share of open payables more than 90 days past due.', formula: shareOf(opIn('ap_over_90'), opIn('ap_open')), unit: 'percent', direction: 'lower_better', period: { nature: 'balance' }, requires: ['ap_subledger'], audiences: FIN }),
  d({ key: 'top_vendor_concentration', name: 'Largest vendor share of spend', group: 'payables', definition: "The largest vendor's share of bills entered in the period.", formula: concentration('vendor_spend', 'top1'), unit: 'percent', direction: 'lower_better', requires: ['ap_subledger'], audiences: FIN }),
  d({ key: 'top5_vendor_concentration', name: 'Top 5 vendors share of spend', group: 'payables', definition: "The five largest vendors' share of bills entered in the period.", formula: concentration('vendor_spend', 'top5'), unit: 'percent', direction: 'lower_better', requires: ['ap_subledger'], audiences: FIN }),
  d({ key: 'early_pay_discount_capture', name: 'Early-pay discount capture', group: 'payables', definition: 'Early-payment discounts taken as a share of discounts offered.', formula: div(opIn('discounts_taken'), opIn('discounts_offered'), 'positive'), unit: 'percent', direction: 'higher_better', requires: ['ap_discounts'], audiences: FIN }),
  d({ key: 'dio', name: 'DIO (days inventory outstanding)', group: 'working_capital', definition: 'Inventory at period end divided by cost of revenue for the period, times the days in the period.', formula: daysOf(bal('inventory'), flow('cogs')), unit: 'days', direction: 'lower_better', period: { nature: 'mixed' }, requires: ['gl', 'inventory'], audiences: [...FIN, 'dealer'] }),
  d({ key: 'inventory_turnover', name: 'Inventory turnover', group: 'working_capital', definition: 'Trailing-twelve-month cost of revenue divided by average inventory.', formula: div(flow('cogs'), bal('inventory', 'average'), 'positive'), unit: 'times', direction: 'higher_better', period: { nature: 'mixed', basis: 'ttm' }, requires: ['gl', 'inventory'], audiences: [...FIN, 'dealer'] }),
  d({
    key: 'cash_conversion_cycle',
    name: 'Cash conversion cycle',
    group: 'working_capital',
    definition: 'DSO plus DIO less DPO: the days between paying suppliers and collecting from customers. DIO counts as 0 when the business carries no inventory.',
    formula: sub(add(metric('dso'), fallback(metric('dio'), 0, ['not_mapped'], 'No inventory accounts, so DIO counts as 0.')), metric('dpo')),
    unit: 'days',
    direction: 'lower_better',
    period: { nature: 'mixed' },
    audiences: [...ALL, 'lender'],
  }),

  // ── Leverage & lender ─────────────────────────────────────────────────────
  d({ key: 'total_debt', name: 'Total debt', group: 'leverage', definition: 'Notes, term loans, lines of credit and floor-plan payable at period end.', formula: bal('total_debt'), unit: 'money', direction: 'lower_better', period: { nature: 'balance' }, audiences: LENDER }),
  d({ key: 'net_debt', name: 'Net debt', group: 'leverage', definition: 'Total debt less cash.', formula: sub(bal('total_debt'), bal('cash')), unit: 'money', direction: 'lower_better', period: { nature: 'balance' }, audiences: LENDER }),
  d({
    key: 'debt_to_ebitda',
    name: 'Debt / EBITDA',
    group: 'leverage',
    definition: 'Total debt divided by trailing-twelve-month EBITDA. Not meaningful when EBITDA is zero or negative.',
    formula: div(bal('total_debt'), metric('ebitda'), 'positive'),
    unit: 'times',
    direction: 'lower_better',
    period: { nature: 'mixed', basis: 'ttm' },
    audiences: LENDER,
    benchmark: { source: LENDING, bands: [{ label: 'Conservative', max: 2.5, tone: 'good' }, { label: 'Elevated', min: 2.5, max: 4, tone: 'watch' }, { label: 'High', min: 4, tone: 'poor' }] },
  }),
  d({ key: 'net_debt_to_ebitda', name: 'Net debt / EBITDA', group: 'leverage', definition: 'Net debt divided by trailing-twelve-month EBITDA.', formula: div(metric('net_debt'), metric('ebitda'), 'positive'), unit: 'times', direction: 'lower_better', period: { nature: 'mixed', basis: 'ttm' }, audiences: LENDER }),
  d({ key: 'equity', name: 'Net worth (equity)', group: 'leverage', definition: 'Total assets less total liabilities (includes current-year earnings not yet closed to retained earnings).', formula: sub(bal('total_assets'), bal('total_liabilities')), unit: 'money', direction: 'higher_better', period: { nature: 'balance' }, audiences: [...LENDER, 'construction'] }),
  d({ key: 'tangible_net_worth', name: 'Tangible net worth', group: 'leverage', definition: 'Net worth less goodwill and intangible assets.', formula: sub(metric('equity'), bal('intangibles')), unit: 'money', direction: 'higher_better', period: { nature: 'balance' }, audiences: [...LENDER, 'construction'] }),
  d({ key: 'debt_to_equity', name: 'Debt / equity', group: 'leverage', definition: 'Total debt divided by net worth. Not meaningful when net worth is zero or negative.', formula: div(bal('total_debt'), metric('equity'), 'positive'), unit: 'ratio', direction: 'lower_better', period: { nature: 'balance' }, audiences: LENDER }),
  d({
    key: 'liabilities_to_net_worth',
    name: 'Liabilities / net worth',
    group: 'leverage',
    definition: 'Total liabilities divided by net worth — the surety underwriter’s leverage test.',
    formula: div(bal('total_liabilities'), metric('equity'), 'positive'),
    unit: 'ratio',
    direction: 'lower_better',
    period: { nature: 'balance' },
    audiences: [...LENDER, 'construction'],
    benchmark: { source: 'Surety underwriting practice (editable per tenant)', bands: [{ label: 'Strong', max: 2, tone: 'good' }, { label: 'Acceptable', min: 2, max: 3, tone: 'watch' }, { label: 'Stretched', min: 3, tone: 'poor' }] },
  }),
  d({
    key: 'interest_coverage',
    name: 'Interest coverage',
    group: 'leverage',
    definition: 'Trailing-twelve-month operating income (EBIT) divided by interest expense.',
    formula: div(metric('operating_income'), flow('interest_expense'), 'positive'),
    unit: 'times',
    direction: 'higher_better',
    period: { basis: 'ttm' },
    audiences: LENDER,
    benchmark: { source: LENDING, bands: [{ label: 'Comfortable', min: 3, tone: 'good' }, { label: 'Thin', min: 1.5, max: 3, tone: 'watch' }, { label: 'Weak', max: 1.5, tone: 'poor' }] },
  }),
  d({ key: 'debt_service', name: 'Debt service', group: 'leverage', definition: 'Interest expense plus principal repaid on notes and loans over the trailing twelve months.', formula: add(flow('interest_expense'), flow('debt_repaid')), unit: 'money', direction: 'neutral', period: { basis: 'ttm' }, audiences: LENDER }),
  d({
    key: 'dscr',
    name: 'Debt service coverage (DSCR)',
    group: 'leverage',
    definition: 'Trailing-twelve-month EBITDA divided by debt service (interest plus principal repaid).',
    formula: div(metric('ebitda'), metric('debt_service'), 'positive'),
    unit: 'times',
    direction: 'higher_better',
    period: { basis: 'ttm' },
    audiences: LENDER,
    benchmark: { source: LENDING, bands: [{ label: 'Passing with room', min: 1.5, tone: 'good' }, { label: 'Near a typical 1.25× covenant', min: 1.25, max: 1.5, tone: 'watch' }, { label: 'Below 1.25×', max: 1.25, tone: 'poor' }] },
  }),
  d({
    key: 'fccr',
    name: 'Fixed-charge coverage (FCCR)',
    group: 'leverage',
    definition: '(Trailing-twelve-month EBITDA − capital expenditure − income taxes − distributions) ÷ debt service. All capex is treated as unfunded (conservative).',
    formula: div(sub(metric('ebitda'), add(flow('capex'), flow('income_tax_expense'), flow('distributions'))), metric('debt_service'), 'positive'),
    unit: 'times',
    direction: 'higher_better',
    period: { basis: 'ttm' },
    audiences: LENDER,
    benchmark: { source: LENDING, bands: [{ label: 'Comfortable', min: 1.25, tone: 'good' }, { label: 'Near covenant', min: 1, max: 1.25, tone: 'watch' }, { label: 'Below 1×', max: 1, tone: 'poor' }] },
  }),
  d({ key: 'covenant_headroom_min', name: 'Minimum covenant headroom', group: 'leverage', definition: 'The tightest headroom across all measured covenants, as a share of each threshold.', formula: opIn('covenant_min_headroom'), unit: 'percent', direction: 'higher_better', period: { nature: 'balance' }, requires: ['covenants'], audiences: LENDER }),

  // ── Returns ───────────────────────────────────────────────────────────────
  d({ key: 'roa', name: 'Return on assets', group: 'returns', definition: 'Trailing-twelve-month net income divided by average total assets.', formula: div(metric('net_income'), bal('total_assets', 'average'), 'positive'), unit: 'percent', direction: 'higher_better', period: { nature: 'mixed', basis: 'ttm' }, audiences: ['owner', 'cfo'] }),
  d({ key: 'roe', name: 'Return on equity', group: 'returns', definition: 'Trailing-twelve-month net income divided by average net worth. Not meaningful when net worth is zero or negative.', formula: div(metric('net_income'), sub(bal('total_assets', 'average'), bal('total_liabilities', 'average')), 'positive'), unit: 'percent', direction: 'higher_better', period: { nature: 'mixed', basis: 'ttm' }, audiences: ['owner', 'cfo'] }),
  d({ key: 'asset_turnover', name: 'Asset turnover', group: 'returns', definition: 'Trailing-twelve-month revenue divided by average total assets.', formula: div(rev, bal('total_assets', 'average'), 'positive'), unit: 'times', direction: 'higher_better', period: { nature: 'mixed', basis: 'ttm' }, audiences: FIN }),

  // ── Efficiency ────────────────────────────────────────────────────────────
  d({ key: 'average_headcount', name: 'Average headcount', group: 'efficiency', definition: 'Average month-end headcount (people paid in the month) over the period.', formula: opIn('headcount', { at: 'window_average' }), unit: 'count', direction: 'neutral', requires: ['headcount'], audiences: ['owner', 'cfo'] }),
  d({ key: 'revenue_per_employee', name: 'Revenue per employee', group: 'efficiency', definition: 'Trailing-twelve-month revenue divided by average headcount (needs at least 6 months of headcount).', formula: div(rev, opIn('headcount', { at: 'window_average', minMonths: 6 }), 'positive'), unit: 'money', direction: 'higher_better', period: { basis: 'ttm' }, requires: ['gl', 'headcount'], audiences: ['owner', 'cfo', 'practice'] }),
  d({ key: 'ebitda_per_employee', name: 'EBITDA per employee', group: 'efficiency', definition: 'Trailing-twelve-month EBITDA divided by average headcount (needs at least 6 months of headcount).', formula: div(metric('ebitda'), opIn('headcount', { at: 'window_average', minMonths: 6 }), 'positive'), unit: 'money', direction: 'higher_better', period: { basis: 'ttm' }, requires: ['gl', 'headcount'], audiences: ['owner', 'cfo'] }),
  d({ key: 'payroll_per_employee', name: 'Payroll cost per employee', group: 'efficiency', definition: 'Trailing-twelve-month payroll and benefits divided by average headcount.', formula: div(flow('payroll_expense'), opIn('headcount', { at: 'window_average', minMonths: 6 }), 'positive'), unit: 'money', direction: 'neutral', period: { basis: 'ttm' }, requires: ['gl', 'headcount'], audiences: FIN }),

  // ── Strategic ─────────────────────────────────────────────────────────────
  d({
    key: 'rule_of_40',
    name: 'Rule of 40',
    group: 'strategic',
    definition: 'Trailing-twelve-month revenue growth plus EBITDA margin. 40 or more is the investor rule of thumb for balanced growth and profit.',
    formula: add(metric('revenue_growth_yoy'), metric('ebitda_margin')),
    unit: 'percent',
    direction: 'higher_better',
    period: { basis: 'ttm' },
    audiences: ['owner', 'cfo'],
    benchmark: { source: 'Investor rule of thumb', bands: [{ label: 'At or above 40', min: 40, tone: 'good' }, { label: '20–40', min: 20, max: 40, tone: 'watch' }, { label: 'Below 20', max: 20, tone: 'poor' }] },
  }),
  d({ key: 'operating_leverage', name: 'Operating leverage', group: 'strategic', definition: 'Year-over-year % change in operating income divided by % change in revenue (trailing twelve months). Above 1 means profit moves faster than sales.', formula: div(growth(metric('operating_income'), 12), growth(rev, 12)), unit: 'times', direction: 'neutral', period: { basis: 'ttm' }, audiences: ['cfo'] }),

  // ── Construction ──────────────────────────────────────────────────────────
  d({ key: 'backlog', name: 'Backlog', group: 'construction', definition: 'Signed contract revenue not yet earned on active jobs.', formula: opIn('backlog'), unit: 'money', direction: 'higher_better', period: { nature: 'balance' }, requires: ['jobs'], audiences: ['owner', 'cfo', 'lender', 'construction'] }),
  d({ key: 'months_of_backlog', name: 'Months of backlog', group: 'construction', definition: 'Backlog divided by average monthly revenue over the trailing twelve months.', formula: div(opIn('backlog'), div(rev, k(12, '12')), 'positive'), unit: 'months', direction: 'higher_better', period: { nature: 'mixed', basis: 'ttm' }, requires: ['gl', 'jobs'], audiences: ['owner', 'cfo', 'lender', 'construction'] }),
  d({ key: 'gp_in_backlog', name: 'Gross profit in backlog', group: 'construction', definition: 'Estimated gross profit still to be earned on backlog, at each job’s estimated margin.', formula: opIn('gp_in_backlog'), unit: 'money', direction: 'higher_better', period: { nature: 'balance' }, requires: ['jobs'], audiences: ['owner', 'cfo', 'construction'] }),
  d({ key: 'backlog_margin', name: 'Backlog gross margin', group: 'construction', definition: 'Gross profit in backlog as a share of backlog.', formula: div(opIn('gp_in_backlog'), opIn('backlog'), 'positive'), unit: 'percent', direction: 'higher_better', period: { nature: 'balance' }, requires: ['jobs'], audiences: ['cfo', 'construction'] }),
  d({ key: 'underbillings', name: 'Underbillings', group: 'construction', definition: 'Revenue earned but not yet billed on active jobs (costs and earnings in excess of billings), from the WIP schedule.', formula: opIn('wip_underbillings'), unit: 'money', direction: 'lower_better', period: { nature: 'balance' }, requires: ['jobs'], audiences: ['cfo', 'controller', 'lender', 'construction'] }),
  d({ key: 'overbillings', name: 'Overbillings', group: 'construction', definition: 'Billings ahead of revenue earned on active jobs (billings in excess of costs and earnings), from the WIP schedule.', formula: opIn('wip_overbillings'), unit: 'money', direction: 'neutral', period: { nature: 'balance' }, requires: ['jobs'], audiences: ['cfo', 'controller', 'lender', 'construction'] }),
  d({ key: 'net_over_under_billings', name: 'Net over/(under) billings', group: 'construction', definition: 'Overbillings less underbillings. Negative means more revenue is earned than billed.', formula: sub(opIn('wip_overbillings'), opIn('wip_underbillings')), unit: 'money', direction: 'neutral', period: { nature: 'balance' }, requires: ['jobs'], audiences: ['cfo', 'controller', 'construction'] }),
  d({
    key: 'wip_gl_variance',
    name: 'WIP adjustment not yet booked',
    group: 'construction',
    definition: 'Net under/(over) billings on the WIP schedule less the contract asset/liability balances in the GL. Non-zero means the month-end WIP entry is due.',
    formula: sub(sub(opIn('wip_underbillings'), opIn('wip_overbillings')), sub(bal('underbillings'), bal('overbillings'))),
    unit: 'money',
    direction: 'neutral',
    period: { nature: 'balance' },
    requires: ['gl', 'jobs'],
    audiences: ['controller', 'construction'],
  }),
  d({ key: 'job_fade', name: 'Job fade', group: 'construction', definition: 'Bid gross profit less current estimated gross profit on active jobs (positive = margin lost since bid).', formula: opIn('job_fade'), unit: 'money', direction: 'lower_better', period: { nature: 'balance' }, requires: ['jobs'], audiences: ['owner', 'cfo', 'lender', 'construction'] }),
  d({ key: 'cost_to_complete', name: 'Cost to complete', group: 'construction', definition: 'Estimated cost still to be incurred on active jobs.', formula: opIn('cost_to_complete'), unit: 'money', direction: 'neutral', period: { nature: 'balance' }, requires: ['jobs'], audiences: ['cfo', 'construction'] }),
  d({ key: 'job_estimated_gp_pct', name: 'Estimated job gross margin', group: 'construction', definition: 'Estimated gross profit of active jobs as a share of their contract value.', formula: div(opIn('job_estimated_gp'), opIn('job_contract_value'), 'positive'), unit: 'percent', direction: 'higher_better', period: { nature: 'balance' }, requires: ['jobs'], audiences: ['owner', 'cfo', 'construction'] }),
  d({ key: 'active_jobs', name: 'Active jobs', group: 'construction', definition: 'Jobs in progress at period end.', formula: opIn('jobs_active'), unit: 'count', direction: 'neutral', period: { nature: 'balance' }, requires: ['jobs'], audiences: ['construction'] }),
  d({ key: 'retainage_receivable', name: 'Retainage receivable', group: 'construction', definition: 'Retainage held back by customers at period end.', formula: bal('retainage_receivable'), unit: 'money', direction: 'lower_better', period: { nature: 'balance' }, audiences: ['cfo', 'controller', 'construction'] }),
  d({ key: 'retainage_payable', name: 'Retainage payable', group: 'construction', definition: 'Retainage withheld from subcontractors at period end.', formula: bal('retainage_payable'), unit: 'money', direction: 'neutral', period: { nature: 'balance' }, audiences: ['cfo', 'controller', 'construction'] }),

  // ── Dealer ────────────────────────────────────────────────────────────────
  d({ key: 'units_in_stock', name: 'Units in stock', group: 'dealer', definition: 'Whole-goods units on hand at period end.', formula: opIn('units_in_stock'), unit: 'count', direction: 'neutral', period: { nature: 'balance' }, requires: ['dealer'], audiences: ['dealer'] }),
  d({ key: 'floor_plan_days', name: 'Average days in stock', group: 'dealer', definition: 'Average age, in days, of units in stock at period end — the floor-plan carry clock.', formula: div(opIn('unit_days_in_stock'), opIn('units_in_stock'), 'positive'), unit: 'days', direction: 'lower_better', period: { nature: 'balance' }, requires: ['dealer'], audiences: ['dealer', 'cfo', 'lender'] }),
  d({ key: 'aged_units_pct', name: 'Aged units %', group: 'dealer', definition: 'Share of units in stock longer than 180 days.', formula: div(opIn('units_aged'), opIn('units_in_stock'), 'positive'), unit: 'percent', direction: 'lower_better', period: { nature: 'balance' }, requires: ['dealer'], audiences: ['dealer', 'cfo', 'lender'] }),
  d({ key: 'warranty_receivable_days', name: 'Warranty receivable days', group: 'dealer', definition: 'Open warranty claims divided by claims submitted in the period, times the days in the period.', formula: daysOf(opIn('warranty_open'), opIn('warranty_claimed')), unit: 'days', direction: 'lower_better', period: { nature: 'mixed' }, requires: ['dealer'], audiences: ['dealer', 'cfo'] }),
  d({ key: 'floor_plan_payable', name: 'Floor plan payable', group: 'dealer', definition: 'Amount owed to floor-plan lenders at period end.', formula: bal('floor_plan_payable'), unit: 'money', direction: 'neutral', period: { nature: 'balance' }, requires: ['gl', 'dealer'], audiences: ['dealer', 'cfo', 'lender'] }),
  d({ key: 'floor_plan_coverage', name: 'Floor plan to inventory', group: 'dealer', definition: 'Floor plan payable as a share of inventory — how much of the stock is lender-financed.', formula: div(bal('floor_plan_payable'), bal('inventory'), 'positive'), unit: 'percent', direction: 'neutral', period: { nature: 'balance' }, requires: ['gl', 'dealer'], audiences: ['dealer', 'lender'] }),

  // ── Practice & books health ───────────────────────────────────────────────
  d({ key: 'close_cycle_days', name: 'Days to close', group: 'practice', definition: 'Calendar days from month end to the hard close of that month (average across companies).', formula: opIn('close_days'), unit: 'days', direction: 'lower_better', period: { nature: 'balance' }, requires: ['practice'], audiences: ['controller', 'practice', 'cfo'], benchmark: { source: EDITABLE, bands: [{ label: 'Fast', max: 10, tone: 'good' }, { label: 'Typical', min: 10, max: 20, tone: 'watch' }, { label: 'Slow', min: 20, tone: 'poor' }] } }),
  d({ key: 'items_per_bookkeeper', name: 'Items processed per bookkeeper', group: 'practice', definition: 'Bank and card transactions processed in the period divided by bookkeepers assigned.', formula: div(opIn('items_processed'), opIn('bookkeepers'), 'positive'), unit: 'count', direction: 'higher_better', requires: ['practice'], audiences: ['practice', 'controller'] }),
];

// ── Lookup ──────────────────────────────────────────────────────────────────

export const METRICS: ReadonlyMap<string, MetricDefinition> = new Map(DEFINITIONS.map((m) => [m.key, m]));

export function listMetrics(): MetricDefinition[] {
  return [...DEFINITIONS];
}

export function getMetric(key: string): MetricDefinition | undefined {
  return METRICS.get(key);
}

export function metricName(key: string): string {
  return METRICS.get(key)?.name ?? key;
}

/** The human formula string for the (i) tooltip — generated from the tree. */
export function formulaOf(key: string): string {
  const m = METRICS.get(key);
  if (!m) throw new Error(`Unknown metric "${key}"`);
  return formatExpr(m.formula, metricName);
}

/** Metrics tagged for an audience, in registry order. */
export function metricsFor(audience: Audience): MetricDefinition[] {
  return DEFINITIONS.filter((m) => m.audiences.includes(audience));
}

/** The universal finance pack (FPB §1.15). */
export const UNIVERSAL_FINANCE_PACK: readonly string[] = [
  'gross_margin',
  'operating_margin',
  'net_margin',
  'ebitda_margin',
  'dso',
  'dpo',
  'dio',
  'cash_conversion_cycle',
  'current_ratio',
  'debt_to_ebitda',
  'dscr',
  'cash_runway_months',
  'revenue_per_employee',
  'opex_pct_revenue',
];

/** Portal default card set (D §1.1A): Revenue, CAGR 3y, gross margin, EBITDA, EBITDA margin, net income, budget variance, cash. */
export const DEFAULT_DASHBOARD: readonly string[] = [
  'revenue',
  'revenue_cagr_3y',
  'gross_margin',
  'ebitda',
  'ebitda_margin',
  'net_income',
  'revenue_budget_variance',
  'cash',
];
