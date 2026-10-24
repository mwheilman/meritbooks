/**
 * The report library (Wave 3A). Each engine report is a DEFINITION — a preset
 * ReportRequest — rendered by the one viewer. Keys keep the legacy `/reports?report=<key>`
 * URLs working (pnl, pnl_month, pnl_dept, pnl_class, bs, cf, equity_changes, tb, consol,
 * bva, gl). Reports not yet on the engine (aging, customer/vendor, jobs, dealer, direct
 * cash flow) stay in the legacy viewer and are listed with `legacy: true`.
 */
import type { ReportRequest } from '@/lib/reports/engine/types';

export type ShelfKey = 'statements' | 'performance' | 'dimensions' | 'group' | 'plan' | 'ledger' | 'receivables' | 'payables' | 'jobs' | 'other';

export const SHELVES: ReadonlyArray<{ key: ShelfKey; label: string; question: string }> = [
  { key: 'statements', label: 'Financial statements', question: 'Where do we stand?' },
  { key: 'performance', label: 'Performance over time', question: 'How did we do, and how is it trending?' },
  { key: 'dimensions', label: 'By department, class, job', question: 'Which part of the business made the money?' },
  { key: 'group', label: 'Companies and consolidation', question: 'How does each company contribute to the group?' },
  { key: 'plan', label: 'Plan and comparison', question: 'Are we on plan?' },
  { key: 'ledger', label: 'Ledger and close', question: 'Do the books tie?' },
  { key: 'receivables', label: 'Receivables', question: 'Who owes us?' },
  { key: 'payables', label: 'Payables', question: 'Who do we owe?' },
  { key: 'jobs', label: 'Jobs and projects', question: 'Which jobs make money?' },
  { key: 'other', label: 'Other', question: '' },
];

export type RequestPreset = Omit<ReportRequest, 'scope' | 'period' | 'basis' | 'rounding'> & {
  period?: Partial<ReportRequest['period']>;
  consolidate?: boolean;
};

export interface LibraryReport {
  key: string;
  label: string;
  desc: string;
  shelf: ShelfKey;
  /** engine definition; absent for legacy reports */
  preset?: RequestPreset;
  legacy?: boolean;
  keywords?: string;
}

const PNL: RequestPreset = { statement: 'income_statement', columns: 'single', compare: [] };

export const ENGINE_REPORTS: LibraryReport[] = [
  { key: 'pnl', label: 'Profit and loss', desc: 'Revenue, cost of sales, gross profit, operating expenses, net income. % of revenue and comparisons on demand.', shelf: 'statements', preset: { ...PNL, compare: ['prior_year'] }, keywords: 'income statement p&l profit loss' },
  { key: 'bs', label: 'Balance sheet', desc: 'Assets, liabilities and equity as of a date — always balances, earnings not yet closed shown.', shelf: 'statements', preset: { statement: 'balance_sheet', columns: 'single', compare: ['prior_year'] }, keywords: 'balance sheet assets liabilities equity' },
  { key: 'cf', label: 'Cash flow statement', desc: 'Indirect method for any set of companies: operating, investing, financing; ties to balance-sheet cash.', shelf: 'statements', preset: { statement: 'cash_flow', columns: 'single', compare: [] }, keywords: 'cash flow indirect operating investing financing' },
  { key: 'equity_changes', label: 'Changes in equity', desc: 'Beginning + contributions/distributions + net income + year-end close = ending, per equity account.', shelf: 'statements', preset: { statement: 'equity_changes', columns: 'single', compare: [] }, keywords: 'equity statement retained earnings distributions' },
  { key: 'pnl_ebitda', label: 'P&L — standard lines to EBITDA', desc: 'Revenue → gross profit → EBITDA → D&A, interest, taxes → net income. Each line opens to its accounts.', shelf: 'performance', preset: { ...PNL, layout: { kind: 'ebitda' }, compare: ['prior_year'] }, keywords: 'ebitda standard lines' },
  { key: 'pnl_month', label: 'P&L by month', desc: 'Twelve or twenty-four months across with a Total and a trailing-twelve-months column.', shelf: 'performance', preset: { ...PNL, columns: 'month', ttmColumn: true, period: { preset: 'ttm' } }, keywords: 'monthly trend 12 months 24 months ttm' },
  { key: 'pnl_quarter', label: 'P&L by quarter', desc: 'Fiscal quarters across with a Total.', shelf: 'performance', preset: { ...PNL, columns: 'quarter', period: { preset: 'year' } }, keywords: 'quarterly' },
  { key: 'pnl_year', label: 'P&L by year', desc: 'Three to five fiscal years side by side.', shelf: 'performance', preset: { ...PNL, columns: 'year', columnCount: 3, period: { preset: 'year' } }, keywords: 'annual multi-year cagr' },
  { key: 'pnl_compare', label: 'Comparative P&L', desc: 'This period against prior period and prior year with $ and % change.', shelf: 'performance', preset: { ...PNL, compare: ['prior_period', 'prior_year'] }, keywords: 'comparative variance change yoy mom' },
  { key: 'pnl_common', label: 'Common-size P&L', desc: 'Every line as a percent of revenue, this period and last year.', shelf: 'performance', preset: { ...PNL, commonSize: true, compare: ['prior_year'], variance: false }, keywords: 'common size percent of revenue margin' },
  { key: 'bs_month', label: 'Balance sheet by month', desc: 'Month-end balances across twelve months.', shelf: 'performance', preset: { statement: 'balance_sheet', columns: 'month', compare: [], period: { preset: 'ttm' } }, keywords: 'monthly balance sheet trend' },
  { key: 'bs_common', label: 'Common-size balance sheet', desc: 'Every line as a percent of total assets, now and a year ago.', shelf: 'performance', preset: { statement: 'balance_sheet', columns: 'single', commonSize: true, compare: ['prior_year'], variance: false }, keywords: 'common size percent of assets' },
  { key: 'pnl_dept', label: 'P&L by department', desc: 'One column per department, plus Unassigned and Total.', shelf: 'dimensions', preset: { ...PNL, columns: 'department' }, keywords: 'department' },
  { key: 'pnl_class', label: 'P&L by class', desc: 'One column per class, plus Unassigned and Total.', shelf: 'dimensions', preset: { ...PNL, columns: 'class' }, keywords: 'class' },
  { key: 'pnl_job', label: 'P&L by job', desc: 'One column per job with activity, plus Unassigned and Total.', shelf: 'dimensions', preset: { ...PNL, columns: 'job' }, keywords: 'job project' },
  { key: 'pnl_company', label: 'P&L by company', desc: 'Companies side by side with a Combined total.', shelf: 'group', preset: { ...PNL, columns: 'company' }, keywords: 'company entity location side by side' },
  { key: 'consol', label: 'Consolidated P&L', desc: 'Companies → Combined → Eliminations → Consolidated. Intercompany and interdepartment activity eliminated.', shelf: 'group', preset: { ...PNL, columns: 'company', consolidate: true }, keywords: 'consolidated eliminations intercompany group' },
  { key: 'consol_bs', label: 'Consolidated balance sheet', desc: 'Company balance sheets → Eliminations → Consolidated; balances by construction.', shelf: 'group', preset: { statement: 'balance_sheet', columns: 'company', compare: [], consolidate: true }, keywords: 'consolidated balance sheet eliminations' },
  { key: 'bs_company', label: 'Balance sheet by company', desc: 'Each company’s balance sheet side by side with a Combined total.', shelf: 'group', preset: { statement: 'balance_sheet', columns: 'company', compare: [] }, keywords: 'company balance sheet' },
  { key: 'bva', label: 'Budget vs actual', desc: 'Actual against the budget with $ and % variance, favourable or unfavourable by line.', shelf: 'plan', preset: { ...PNL, compare: ['budget'] }, keywords: 'budget variance plan bva' },
  { key: 'bva_month', label: 'Budget vs actual by month', desc: 'Monthly actuals with the budget compared on the year-to-date total.', shelf: 'plan', preset: { ...PNL, columns: 'month', compare: ['budget'], period: { preset: 'ytd' } }, keywords: 'budget monthly' },
  { key: 'forecast', label: 'Actual vs latest estimate', desc: 'Closed months at actual, open months at budget — the full-year outlook against budget.', shelf: 'plan', preset: { ...PNL, compare: ['forecast', 'budget'], period: { preset: 'year' } }, keywords: 'forecast outlook latest estimate' },
  { key: 'tb', label: 'Trial balance worksheet', desc: 'Unadjusted, adjusting entries and adjusted balances; debits equal credits.', shelf: 'ledger', preset: { statement: 'trial_balance', columns: 'single', compare: [], tbMode: 'worksheet' }, keywords: 'trial balance worksheet adjusting' },
  { key: 'gl', label: 'General ledger', desc: 'Opening, debits, credits and closing by account — open any account for every line, paginated, with running balance.', shelf: 'ledger', preset: { statement: 'gl_summary', columns: 'single', compare: [] }, keywords: 'general ledger detail transactions' },
];

/** Legacy viewer reports (not yet on the engine) — still reachable from the library. */
export const LEGACY_REPORTS: LibraryReport[] = [
  { key: 'cf_direct', label: 'Cash flow (direct)', desc: 'Cash from customers, paid to suppliers and employees.', shelf: 'statements', legacy: true },
  { key: 'equity_table', label: 'Equity table', desc: 'Holders, ownership %, invested, distributions.', shelf: 'statements', legacy: true },
  { key: 'debt', label: 'Debt schedule', desc: 'Loans and lines: balance, rate, maturity, payment.', shelf: 'ledger', legacy: true },
  { key: 'txn_list', label: 'Transaction list', desc: 'Every transaction by date.', shelf: 'ledger', legacy: true },
  { key: 'ar_aging', label: 'AR aging', desc: 'Open invoices by aging bucket.', shelf: 'receivables', legacy: true },
  { key: 'inc_cust', label: 'Income by customer', desc: 'Revenue and collections per customer.', shelf: 'receivables', legacy: true },
  { key: 'sales_cust', label: 'Sales by customer', desc: 'Line-item sales per customer.', shelf: 'receivables', legacy: true },
  { key: 'cust_bal', label: 'Customer balances', desc: 'Open balance per customer.', shelf: 'receivables', legacy: true },
  { key: 'open_ar', label: 'Open invoices', desc: 'Unpaid invoices with days overdue.', shelf: 'receivables', legacy: true },
  { key: 'ap_aging', label: 'AP aging', desc: 'Open bills by aging bucket.', shelf: 'payables', legacy: true },
  { key: 'exp_vend', label: 'Expense by vendor', desc: 'Expenses grouped by vendor.', shelf: 'payables', legacy: true },
  { key: 'vend_bal', label: 'Vendor balances', desc: 'Open balance per vendor.', shelf: 'payables', legacy: true },
  { key: 'open_ap', label: 'Open bills', desc: 'All unpaid bills.', shelf: 'payables', legacy: true },
  { key: 'open', label: 'Open items (AR + AP)', desc: 'Unpaid invoices and bills together.', shelf: 'ledger', legacy: true },
  { key: 'job_prof', label: 'Job profitability', desc: 'Contract, cost, billed, margin per job.', shelf: 'jobs', legacy: true },
  { key: 'wip', label: 'WIP schedule', desc: 'Over / under billed work in progress.', shelf: 'jobs', legacy: true },
  { key: 'job_cost', label: 'Job cost detail', desc: 'Costs by job, phase, cost code.', shelf: 'jobs', legacy: true },
];

export const ALL_REPORTS: LibraryReport[] = [...ENGINE_REPORTS, ...LEGACY_REPORTS];

export function findEngineReport(key: string | null | undefined): LibraryReport | null {
  if (!key) return null;
  return ENGINE_REPORTS.find((r) => r.key === key) ?? null;
}

export function isLegacyKey(key: string | null | undefined): boolean {
  return !!key && !findEngineReport(key);
}

/** Search across label, description, keywords and shelf (case-insensitive, all terms must match). */
export function searchReports(q: string, list: LibraryReport[] = ALL_REPORTS): LibraryReport[] {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return list;
  return list.filter((r) => {
    const hay = `${r.label} ${r.desc} ${r.keywords ?? ''} ${SHELVES.find((s) => s.key === r.shelf)?.label ?? ''}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}
