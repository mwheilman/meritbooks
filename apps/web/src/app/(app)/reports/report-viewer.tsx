'use client';

import { useState, useMemo, useCallback } from 'react';
import React from 'react';
import { clsx } from 'clsx';
import {
  Download, Calendar, Building2, AlertCircle, Loader2, ChevronRight,
  FileText, Users, Briefcase, BarChart3, Shield, DollarSign,
  GitCompare, Layers, List, LayoutGrid, Search, Sparkles,
  ChevronDown, ArrowUpDown
} from 'lucide-react';
import { useQuery } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import type { Location } from '@meritbooks/shared';
import { CashFlowReport } from './cash-flow-report';
import { GlDrillDown } from './gl-drill-down';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

interface DrillDownTarget { accountId?: string; accountNumber: string; accountName: string }

// ═══════════════════════════════════════════════════════════════
// REPORT CATALOG — grouped by category
// ═══════════════════════════════════════════════════════════════

interface ReportDef {
  key: string;
  label: string;
  description: string;
  needsDates: boolean;
  hasBasis: boolean;
  hasDetail: boolean;
  hasCompare: boolean;
}

interface ReportCategory {
  key: string;
  label: string;
  icon: React.ElementType;
  reports: ReportDef[];
}

const REPORT_CATALOG: ReportCategory[] = [
  {
    key: 'financial', label: 'Financial Statements', icon: FileText,
    reports: [
      { key: 'pnl', label: 'Profit & Loss', description: 'Revenue minus expenses for a period', needsDates: true, hasBasis: true, hasDetail: true, hasCompare: true },
      { key: 'pnl_dept', label: 'P&L by Department', description: 'Departmental breakdown of income and expenses', needsDates: true, hasBasis: true, hasDetail: true, hasCompare: false },
      { key: 'pnl_class', label: 'P&L by Class', description: 'P&L filtered by class dimension', needsDates: true, hasBasis: true, hasDetail: true, hasCompare: false },
      { key: 'bs', label: 'Balance Sheet', description: 'Assets, liabilities, and equity at a point in time', needsDates: false, hasBasis: false, hasDetail: true, hasCompare: true },
      { key: 'cf', label: 'Cash Flow Statement', description: 'Operating, investing, and financing activities (indirect method)', needsDates: true, hasBasis: false, hasDetail: false, hasCompare: false },
      { key: 'equity', label: 'Changes in Equity', description: 'Beginning balance + activity = ending balance per equity account', needsDates: true, hasBasis: false, hasDetail: false, hasCompare: false },
      { key: 'tb', label: 'Trial Balance', description: 'All accounts with debit and credit balances', needsDates: false, hasBasis: false, hasDetail: false, hasCompare: false },
      { key: 'consol', label: 'Consolidated Statements', description: 'Combined P&L across entities with intercompany eliminations', needsDates: true, hasBasis: false, hasDetail: false, hasCompare: false },
      { key: 'bva', label: 'Budget vs Actual', description: 'Budget amounts vs GL actuals with $ and % variance', needsDates: true, hasBasis: false, hasDetail: false, hasCompare: false },
    ],
  },
  {
    key: 'ar', label: 'Accounts Receivable', icon: DollarSign,
    reports: [
      { key: 'ar_aging', label: 'AR Aging', description: 'Open invoices by aging bucket (Current, 30, 60, 90, 120+)', needsDates: false, hasBasis: false, hasDetail: true, hasCompare: false },
      { key: 'inc_cust', label: 'Income by Customer', description: 'Revenue, collections, and outstanding by customer', needsDates: true, hasBasis: false, hasDetail: true, hasCompare: false },
      { key: 'sales_cust', label: 'Sales by Customer', description: 'Product/service line breakdown per customer from invoice lines', needsDates: true, hasBasis: false, hasDetail: true, hasCompare: false },
      { key: 'cust_bal', label: 'Customer Balances', description: 'Total invoiced, paid, and open balance per customer', needsDates: false, hasBasis: false, hasDetail: false, hasCompare: false },
      { key: 'open_ar', label: 'Open Invoices', description: 'All unpaid invoices with days overdue', needsDates: false, hasBasis: false, hasDetail: false, hasCompare: false },
    ],
  },
  {
    key: 'ap', label: 'Accounts Payable', icon: Users,
    reports: [
      { key: 'ap_aging', label: 'AP Aging', description: 'Open bills by aging bucket', needsDates: false, hasBasis: false, hasDetail: true, hasCompare: false },
      { key: 'exp_vend', label: 'Expense by Vendor', description: 'All expenses grouped by vendor with account breakdown', needsDates: true, hasBasis: false, hasDetail: true, hasCompare: false },
      { key: 'vend_bal', label: 'Vendor Balances', description: 'Total billed, paid, and open per vendor with 1099 flags', needsDates: false, hasBasis: false, hasDetail: false, hasCompare: false },
      { key: 'open_ap', label: 'Open Bills', description: 'All unpaid bills with days overdue', needsDates: false, hasBasis: false, hasDetail: false, hasCompare: false },
      { key: 'vendor_1099', label: '1099 Summary', description: '1099-eligible vendors with YTD payments for tax reporting', needsDates: true, hasBasis: false, hasDetail: true, hasCompare: false },
    ],
  },
  {
    key: 'jobs', label: 'Jobs & Projects', icon: Briefcase,
    reports: [
      { key: 'job_prof', label: 'Job Profitability', description: 'Contract, cost, billed, margin per job', needsDates: false, hasBasis: false, hasDetail: false, hasCompare: false },
      { key: 'wip', label: 'WIP Schedule', description: 'Work in progress: contract, costs to date, % complete, over/under billed', needsDates: false, hasBasis: false, hasDetail: false, hasCompare: false },
      { key: 'job_cost', label: 'Job Cost Detail', description: 'Cost entries by job, phase, and cost code', needsDates: true, hasBasis: false, hasDetail: true, hasCompare: false },
    ],
  },
  {
    key: 'mgmt', label: 'Management', icon: BarChart3,
    reports: [
      { key: 'gl', label: 'General Ledger', description: 'Every GL transaction line by date range', needsDates: true, hasBasis: false, hasDetail: false, hasCompare: false },
      { key: 'gl_compare', label: 'GL Account Comparison', description: 'Compare any account across two periods', needsDates: true, hasBasis: false, hasDetail: false, hasCompare: true },
      { key: 'txn_list', label: 'Transaction List', description: 'All transactions by date, grouped by day or line-by-line', needsDates: true, hasBasis: false, hasDetail: true, hasCompare: false },
      { key: 'open', label: 'Open Items (AR + AP)', description: 'Combined view of all unpaid invoices and bills', needsDates: false, hasBasis: false, hasDetail: false, hasCompare: false },
    ],
  },
  {
    key: 'tax', label: 'Tax & Compliance', icon: Shield,
    reports: [
      { key: 'sales_tax', label: 'Sales Tax Summary', description: 'Tax collected by jurisdiction and period', needsDates: true, hasBasis: false, hasDetail: true, hasCompare: false },
      { key: 'vendor_1099', label: '1099 Vendor Report', description: '1099-eligible vendors with payment totals', needsDates: true, hasBasis: false, hasDetail: false, hasCompare: false },
    ],
  },
];

// ═══════════════════════════════════════════════════════════════
// PERIOD PRESETS
// ═══════════════════════════════════════════════════════════════

interface PeriodPreset { key: string; label: string; getDates: () => { start: string; end: string } }

function pad(n: number) { return String(n).padStart(2, '0'); }
function fmt(d: Date) { return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }

const PERIOD_PRESETS: PeriodPreset[] = [
  { key: 'this_month', label: 'This Month', getDates: () => { const n = new Date(); return { start: `${n.getFullYear()}-${pad(n.getMonth()+1)}-01`, end: fmt(new Date(n.getFullYear(), n.getMonth()+1, 0)) }; } },
  { key: 'last_month', label: 'Last Month', getDates: () => { const n = new Date(); const lm = new Date(n.getFullYear(), n.getMonth()-1, 1); return { start: fmt(lm), end: fmt(new Date(lm.getFullYear(), lm.getMonth()+1, 0)) }; } },
  { key: 'this_quarter', label: 'This Quarter', getDates: () => { const n = new Date(); const q = Math.floor(n.getMonth()/3)*3; return { start: `${n.getFullYear()}-${pad(q+1)}-01`, end: fmt(new Date(n.getFullYear(), q+3, 0)) }; } },
  { key: 'last_quarter', label: 'Last Quarter', getDates: () => { const n = new Date(); const q = Math.floor(n.getMonth()/3)*3 - 3; const y = q < 0 ? n.getFullYear()-1 : n.getFullYear(); const qm = ((q % 12) + 12) % 12; return { start: `${y}-${pad(qm+1)}-01`, end: fmt(new Date(y, qm+3, 0)) }; } },
  { key: 'ytd', label: 'Year to Date', getDates: () => { const n = new Date(); return { start: `${n.getFullYear()}-01-01`, end: fmt(n) }; } },
  { key: 'last_year', label: 'Last Year', getDates: () => { const y = new Date().getFullYear()-1; return { start: `${y}-01-01`, end: `${y}-12-31` }; } },
  { key: 'last_12', label: 'Last 12 Months', getDates: () => { const n = new Date(); const s = new Date(n.getFullYear()-1, n.getMonth(), n.getDate()+1); return { start: fmt(s), end: fmt(n) }; } },
  { key: 'custom', label: 'Custom Range', getDates: () => { const n = new Date(); return { start: `${n.getFullYear()}-${pad(n.getMonth()+1)}-01`, end: fmt(n) }; } },
];

// ═══════════════════════════════════════════════════════════════
// MAIN REPORT CENTER
// ═══════════════════════════════════════════════════════════════

export function ReportViewer() {
  const [selectedCategory, setSelectedCategory] = useState('financial');
  const [selectedReport, setSelectedReport] = useState<string | null>(null);
  const [periodPreset, setPeriodPreset] = useState('this_month');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [locId, setLocId] = useState('all');
  const [basis, setBasis] = useState<'accrual' | 'cash'>('accrual');
  const [viewMode, setViewMode] = useState<'summary' | 'detail'>('summary');
  const [compare, setCompare] = useState(false);
  const [drill, setDrill] = useState<DrillDownTarget | null>(null);
  const [nlQuery, setNlQuery] = useState('');

  const { data: locs } = useQuery<Location[]>('/api/locations');

  // Compute dates from preset
  const { start: sd, end: ed } = useMemo(() => {
    if (periodPreset === 'custom') return { start: customStart, end: customEnd };
    const preset = PERIOD_PRESETS.find((p) => p.key === periodPreset);
    return preset?.getDates() ?? { start: '', end: '' };
  }, [periodPreset, customStart, customEnd]);

  // Find selected report definition
  const reportDef = useMemo(() => {
    for (const cat of REPORT_CATALOG) {
      const r = cat.reports.find((r) => r.key === selectedReport);
      if (r) return r;
    }
    return null;
  }, [selectedReport]);

  const currentCategory = REPORT_CATALOG.find((c) => c.key === selectedCategory);

  return (
    <div className="flex gap-6 h-[calc(100vh-140px)]">
      {/* ─── Left Sidebar: Report Menu ─── */}
      <div className="w-64 shrink-0 overflow-y-auto">
        {/* NL Query */}
        <div className="relative mb-4">
          <Sparkles className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-indigo-400" />
          <input
            type="text"
            placeholder="Ask for any report..."
            value={nlQuery}
            onChange={(e) => setNlQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-2.5 bg-indigo-500/[0.06] border border-indigo-500/20 rounded-xl text-sm text-white placeholder:text-indigo-300/40 focus:outline-none focus:border-indigo-500/40 transition-colors"
          />
        </div>

        {/* Category list */}
        <nav className="space-y-1">
          {REPORT_CATALOG.map((cat) => {
            const Icon = cat.icon;
            const isActive = selectedCategory === cat.key;
            return (
              <div key={cat.key}>
                <button
                  onClick={() => { setSelectedCategory(cat.key); setSelectedReport(null); }}
                  className={clsx(
                    'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors text-left',
                    isActive ? 'bg-emerald-500/10 text-emerald-400' : 'text-slate-400 hover:text-white hover:bg-slate-800/50'
                  )}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  {cat.label}
                  <ChevronDown className={clsx('w-3 h-3 ml-auto transition-transform', isActive ? 'rotate-0' : '-rotate-90')} />
                </button>

                {/* Report list within category */}
                {isActive && (
                  <div className="ml-6 mt-1 space-y-0.5 border-l border-slate-800 pl-3">
                    {cat.reports.map((report) => (
                      <button
                        key={report.key}
                        onClick={() => setSelectedReport(report.key)}
                        className={clsx(
                          'w-full text-left px-2.5 py-1.5 rounded-md text-xs transition-colors',
                          selectedReport === report.key
                            ? 'bg-slate-800 text-white font-medium'
                            : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800/30'
                        )}
                      >
                        {report.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
      </div>

      {/* ─── Right: Report Content ─── */}
      <div className="flex-1 overflow-y-auto">
        {!selectedReport ? (
          /* ─── No report selected: show category overview ─── */
          <div>
            <h1 className="text-2xl font-semibold text-white mb-2">
              {currentCategory?.label ?? 'Reports'}
            </h1>
            <p className="text-sm text-slate-400 mb-6">Select a report from the menu to generate it.</p>

            <div className="grid grid-cols-2 gap-3">
              {(currentCategory?.reports ?? []).map((report) => (
                <button
                  key={report.key}
                  onClick={() => setSelectedReport(report.key)}
                  className="text-left p-4 rounded-xl border border-slate-800 bg-slate-800/20 hover:bg-slate-800/50 hover:border-slate-700 transition-colors group"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium text-white group-hover:text-emerald-400 transition-colors">{report.label}</span>
                    <ChevronRight className="w-4 h-4 text-slate-600 group-hover:text-emerald-400 transition-colors" />
                  </div>
                  <p className="text-xs text-slate-500">{report.description}</p>
                  <div className="flex gap-2 mt-2">
                    {report.hasBasis && <span className="px-1.5 py-0.5 text-[10px] rounded bg-cyan-500/10 text-cyan-400">Cash/Accrual</span>}
                    {report.hasDetail && <span className="px-1.5 py-0.5 text-[10px] rounded bg-purple-500/10 text-purple-400">Summary/Detail</span>}
                    {report.hasCompare && <span className="px-1.5 py-0.5 text-[10px] rounded bg-amber-500/10 text-amber-400">Comparative</span>}
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          /* ─── Report selected: show controls + content ─── */
          <div>
            {/* Report header + controls */}
            <div className="flex items-start justify-between mb-4">
              <div>
                <h1 className="text-xl font-semibold text-white">{reportDef?.label}</h1>
                <p className="text-xs text-slate-500 mt-0.5">{reportDef?.description}</p>
              </div>
              <button className="btn-secondary btn-sm flex items-center gap-1.5"><Download size={14} />Export</button>
            </div>

            {/* Controls bar */}
            <div className="flex items-center gap-3 mb-5 flex-wrap p-3 rounded-xl bg-slate-800/20 border border-slate-800">
              {/* Period preset */}
              {reportDef?.needsDates !== false && (
                <div className="flex items-center gap-2">
                  <Calendar size={14} className="text-slate-500" />
                  <select
                    value={periodPreset}
                    onChange={(e) => setPeriodPreset(e.target.value)}
                    className="px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white"
                  >
                    {PERIOD_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                  </select>
                  {periodPreset === 'custom' && (
                    <>
                      <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white font-mono w-32" />
                      <span className="text-slate-600 text-xs">to</span>
                      <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white font-mono w-32" />
                    </>
                  )}
                </div>
              )}

              {/* Company filter */}
              <div className="flex items-center gap-1.5">
                <Building2 size={13} className="text-slate-500" />
                <select value={locId} onChange={(e) => setLocId(e.target.value)} className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white">
                  <option value="all">All Companies</option>
                  {(locs ?? []).map((l) => <option key={l.id} value={l.id}>{l.short_code} · {l.name}</option>)}
                </select>
              </div>

              {/* Cash vs Accrual */}
              {reportDef?.hasBasis && (
                <div className="flex gap-0.5 p-0.5 rounded-lg bg-slate-900 border border-slate-700">
                  <button onClick={() => setBasis('accrual')} className={clsx('px-2.5 py-1 rounded-md text-xs font-medium transition-colors', basis === 'accrual' ? 'bg-slate-700 text-white' : 'text-slate-500 hover:text-slate-300')}>Accrual</button>
                  <button onClick={() => setBasis('cash')} className={clsx('px-2.5 py-1 rounded-md text-xs font-medium transition-colors', basis === 'cash' ? 'bg-slate-700 text-white' : 'text-slate-500 hover:text-slate-300')}>Cash</button>
                </div>
              )}

              {/* Summary / Detail */}
              {reportDef?.hasDetail && (
                <div className="flex gap-0.5 p-0.5 rounded-lg bg-slate-900 border border-slate-700">
                  <button onClick={() => setViewMode('summary')} className={clsx('px-2 py-1 rounded-md text-xs flex items-center gap-1 transition-colors', viewMode === 'summary' ? 'bg-slate-700 text-white' : 'text-slate-500')}><LayoutGrid size={11} />Summary</button>
                  <button onClick={() => setViewMode('detail')} className={clsx('px-2 py-1 rounded-md text-xs flex items-center gap-1 transition-colors', viewMode === 'detail' ? 'bg-slate-700 text-white' : 'text-slate-500')}><List size={11} />Detail</button>
                </div>
              )}

              {/* Compare */}
              {reportDef?.hasCompare && (
                <button onClick={() => setCompare(!compare)} className={clsx('flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors', compare ? 'bg-indigo-600/20 text-indigo-400 border-indigo-500/30' : 'bg-slate-800 text-slate-400 border-slate-700')}>
                  <GitCompare size={11} />{compare ? 'Comparing' : 'Compare'}
                </button>
              )}
            </div>

            {/* Report content — lazy loaded */}
            <ReportContent
              reportKey={selectedReport}
              sd={sd} ed={ed} locId={locId}
              basis={basis} viewMode={viewMode} compare={compare}
              onDrill={setDrill}
            />
          </div>
        )}
      </div>

      {/* Drill-down modal */}
      {drill && <GlDrillDown accountId={drill.accountId} accountNumber={drill.accountNumber} accountName={drill.accountName} startDate={sd} endDate={ed} locationId={locId} onClose={() => setDrill(null)} />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// REPORT CONTENT ROUTER — loads the right report
// ═══════════════════════════════════════════════════════════════

function ReportContent({ reportKey, sd, ed, locId, basis, viewMode, compare, onDrill }: {
  reportKey: string; sd: string; ed: string; locId: string;
  basis: 'accrual' | 'cash'; viewMode: 'summary' | 'detail'; compare: boolean;
  onDrill: (t: DrillDownTarget) => void;
}) {
  // Build common params
  const p: Record<string, string> = {};
  if (sd) p.start_date = sd;
  if (ed) p.end_date = ed;
  if (locId !== 'all') p.location_id = locId;

  switch (reportKey) {
    case 'pnl': return <PnlReport p={p} onDrill={onDrill} compare={compare} />;
    case 'bs': return <BsReport ed={ed} locId={locId} onDrill={onDrill} />;
    case 'cf': return <CashFlowReport startDate={sd} endDate={ed} locationId={locId} />;
    case 'tb': return <TbReport locId={locId} onDrill={onDrill} />;
    case 'gl': return <SimpleApiReport url="/api/reports/gl-detail" params={p} title="General Ledger" />;
    case 'ar_aging': return <SimpleApiReport url="/api/reports/ar-aging" params={{ location_id: locId !== 'all' ? locId : '' }} title="AR Aging" />;
    case 'ap_aging': return <SimpleApiReport url="/api/reports/ap-aging" params={{ location_id: locId !== 'all' ? locId : '' }} title="AP Aging" />;
    case 'job_prof': return <SimpleApiReport url="/api/reports/job-profitability" params={{ location_id: locId !== 'all' ? locId : '' }} title="Job Profitability" />;
    case 'bva': return <SimpleApiReport url="/api/budgets/vs-actual" params={{ ...p, fiscal_year: sd?.slice(0,4) ?? '' }} title="Budget vs Actual" />;
    case 'consol': return <SimpleApiReport url="/api/reports/consolidated" params={p} title="Consolidated" />;
    case 'equity': return <SimpleApiReport url="/api/reports/equity-changes" params={p} title="Changes in Equity" />;
    case 'inc_cust': return <SimpleApiReport url="/api/reports/income-by-customer" params={{ ...p, mode: viewMode }} title="Income by Customer" />;
    case 'sales_cust': return <SimpleApiReport url="/api/reports/sales-by-customer" params={{ ...p, mode: viewMode }} title="Sales by Customer" />;
    case 'exp_vend': return <SimpleApiReport url="/api/reports/expense-by-vendor" params={{ ...p, mode: viewMode }} title="Expense by Vendor" />;
    case 'vend_bal': return <SimpleApiReport url="/api/reports/vendor-balances" params={{ location_id: locId !== 'all' ? locId : '' }} title="Vendor Balances" />;
    case 'cust_bal': return <SimpleApiReport url="/api/reports/customer-balances" params={{ location_id: locId !== 'all' ? locId : '' }} title="Customer Balances" />;
    case 'open': case 'open_ar': case 'open_ap': return <SimpleApiReport url="/api/reports/open-items" params={{ location_id: locId !== 'all' ? locId : '', type: reportKey === 'open_ar' ? 'ar' : reportKey === 'open_ap' ? 'ap' : '' }} title="Open Items" />;
    case 'txn_list': return <SimpleApiReport url="/api/reports/transaction-list" params={{ ...p, mode: viewMode }} title="Transaction List" />;
    default: return <div className="card p-8 text-center text-slate-500">Report "{reportKey}" is not yet implemented. Select a different report.</div>;
  }
}

// ═══════════════════════════════════════════════════════════════
// SHARED COMPONENTS
// ═══════════════════════════════════════════════════════════════

function Ld() { return <div className="card p-12 flex items-center justify-center"><Loader2 size={24} className="animate-spin text-slate-500" /></div>; }
function Er({ m }: { m: string }) { return <div className="card p-8 text-center"><AlertCircle size={24} className="mx-auto text-red-400 mb-2" /><p className="text-sm text-red-400">{m}</p></div>; }
function Em({ m }: { m?: string }) { return <div className="card p-8 text-center text-sm text-slate-500">{m ?? 'No data for this period. This report will populate as transactions are posted.'}</div>; }

// Generic API report — fetches data and dumps JSON for now
// Each report type should have its own renderer, but this serves as a fallback
function SimpleApiReport({ url, params, title }: { url: string; params: Record<string, string>; title: string }) {
  const cleanParams = Object.fromEntries(Object.entries(params).filter(([,v]) => v));
  const qs = new URLSearchParams(cleanParams).toString();
  const { data, isLoading, error } = useQuery<any>(`${url}${qs ? '?' + qs : ''}`);
  if (isLoading) return <Ld />;
  if (error) return <Er m={String(error)} />;
  if (!data) return <Em />;

  // Try to render a table from data.data array
  const rows = data.data ?? data.accounts ?? data.reconciliations ?? [];
  if (!Array.isArray(rows) || rows.length === 0) return <Em m={`No ${title.toLowerCase()} data found for this period.`} />;

  const keys = Object.keys(rows[0]).filter((k) => !k.includes('Id') && !k.includes('id') && k !== 'transactions' && k !== 'invoices' && k !== 'details' && k !== 'aging' && k !== 'accounts' && k !== 'byAccount' && k !== 'byLocation');

  return (
    <div className="card overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-800">
        <h2 className="text-base font-semibold text-white">{title}</h2>
        <p className="text-2xs text-slate-500 mt-0.5">{rows.length} rows</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800/50">
              {keys.map((k) => (
                <th key={k} className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500 whitespace-nowrap">{k.replace(/([A-Z])/g, ' $1').replace(/Cents$/, '').trim()}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/30">
            {rows.slice(0, 200).map((row: any, i: number) => (
              <tr key={i} className="hover:bg-slate-800/20">
                {keys.map((k) => {
                  const v = row[k];
                  const isMoney = typeof k === 'string' && (k.endsWith('Cents') || k.includes('cents') || k.includes('Cents'));
                  const isBool = typeof v === 'boolean';
                  const isPct = typeof k === 'string' && (k.includes('Pct') || k.includes('pct'));
                  return (
                    <td key={k} className={clsx('px-4 py-1.5 whitespace-nowrap', isMoney || isPct ? 'text-right font-mono' : '', isMoney ? 'text-slate-200' : 'text-slate-400')}>
                      {isMoney ? formatMoney(Number(v ?? 0)) : isBool ? (v ? '✓' : '—') : isPct ? `${v}%` : String(v ?? '—')}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// P&L with % revenue, drill-down, comparative
// ═══════════════════════════════════════════════════════════════

interface ISAcct { accountId: string; accountNumber: string; accountName: string; amountCents: number }
interface ISGroup { name: string; accounts: ISAcct[]; totalCents: number }
interface ISSection { type: string; label: string; groups: ISGroup[]; totalCents: number }
interface ISR { sections: ISSection[]; summary: { revenueCents: number; cogsCents: number; grossProfitCents: number; opexCents: number; ebitdaCents: number; otherCents: number; netIncomeCents: number; grossMarginPct: number; netMarginPct: number } }

function PnlReport({ p, onDrill, compare }: { p: Record<string, string>; onDrill: (t: DrillDownTarget) => void; compare: boolean }) {
  const { data, isLoading, error } = useQuery<ISR>('/api/reports/income-statement', p);
  // Prior period
  const priorEnd = p.start_date ? new Date(p.start_date) : new Date();
  priorEnd.setDate(priorEnd.getDate() - 1);
  const priorStart = `${priorEnd.getFullYear()}-${pad(priorEnd.getMonth()+1)}-01`;
  const pp = { ...p, start_date: priorStart, end_date: fmt(priorEnd) };
  const { data: pd } = useQuery<ISR>(compare ? '/api/reports/income-statement' : null, compare ? pp : undefined);

  if (isLoading) return <Ld />;
  if (error) return <Er m={String(error)} />;
  if (!data) return <Em />;
  const { sections, summary: s } = data;
  const rb = Math.abs(s.revenueCents) || 1;
  const pm = new Map<string, number>();
  if (pd) pd.sections.forEach((sec) => sec.groups.forEach((g) => g.accounts.forEach((a) => pm.set(a.accountNumber, a.amountCents))));

  return (
    <div className="card overflow-hidden">
      <table className="w-full"><thead><tr className="border-b border-slate-800/50"><th className="px-6 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500 w-24">Acct</th><th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Description</th><th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500">Amount</th><th className="px-3 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500 w-14">%</th>{compare&&<><th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500">Prior</th><th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500">Var</th></>}</tr></thead>
        <tbody>
          {sections.map((sec) => (<React.Fragment key={sec.type}>
            <tr className="bg-slate-800/30"><td colSpan={compare?6:4} className="px-6 py-2 text-xs font-semibold text-slate-300 uppercase">{sec.label} <span className="font-mono text-slate-500 ml-1">{formatMoney(sec.totalCents)}</span></td></tr>
            {sec.groups.flatMap((g) => g.accounts.map((a) => { const pv = pm.get(a.accountNumber)??0; const v = a.amountCents-pv; return (
              <tr key={a.accountNumber} onClick={() => onDrill({accountId:a.accountId,accountNumber:a.accountNumber,accountName:a.accountName})} className="cursor-pointer hover:bg-slate-800/40 transition-colors"><td className="px-6 py-1.5 text-xs font-mono text-slate-500 pl-10">{a.accountNumber}</td><td className="px-4 py-1.5 text-sm text-slate-300 flex items-center gap-1">{a.accountName}<ChevronRight size={10} className="text-slate-600"/></td><td className="px-4 py-1.5 text-right text-sm font-mono tabular-nums text-slate-200">{formatMoney(a.amountCents)}</td><td className="px-3 py-1.5 text-right text-2xs font-mono text-slate-600">{Math.round(Math.abs(a.amountCents)/rb*100)}%</td>{compare&&<><td className="px-4 py-1.5 text-right text-sm font-mono text-slate-400">{formatMoney(pv)}</td><td className={clsx('px-4 py-1.5 text-right text-sm font-mono',v>0?'text-emerald-400':v<0?'text-red-400':'text-slate-500')}>{v>0?'+':''}{formatMoney(v)}</td></>}</tr>
            ); }))}
          </React.Fragment>))}
          <tr className="bg-slate-800/20"><td/><td className="px-4 py-2.5 text-sm font-semibold text-white">Gross Profit</td><td className="px-4 py-2.5 text-right text-base font-mono font-semibold text-white">{formatMoney(s.grossProfitCents)} <span className="text-2xs text-slate-500">{s.grossMarginPct}%</span></td><td/>{compare&&<td colSpan={2}/>}</tr>
          <tr className="bg-brand-500/[0.04]"><td/><td className="px-4 py-2.5 text-sm font-semibold text-white">Net Income</td><td className={clsx('px-4 py-2.5 text-right text-base font-mono font-semibold',s.netIncomeCents>=0?'text-emerald-400':'text-red-400')}>{formatMoney(s.netIncomeCents)} <span className="text-2xs text-slate-500">{s.netMarginPct}%</span></td><td/>{compare&&<td colSpan={2}/>}</tr>
        </tbody>
      </table>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// BALANCE SHEET
// ═══════════════════════════════════════════════════════════════

function BsReport({ ed, locId, onDrill }: { ed: string; locId: string; onDrill: (t: DrillDownTarget) => void }) {
  const p: Record<string, string> = { as_of_date: ed };
  if (locId !== 'all') p.location_id = locId;
  const { data, isLoading, error } = useQuery<{ sections: { type: string; label: string; subTypes: { groups: { accounts: { accountId: string; accountNumber: string; accountName: string; balanceCents: number }[] }[] }[]; totalCents: number }[]; summary: { totalAssetsCents: number; totalLiabilitiesCents: number; totalEquityCents: number; isBalanced: boolean; varianceCents: number } }>('/api/reports/balance-sheet', p);
  if (isLoading) return <Ld />;
  if (error) return <Er m={String(error)} />;
  if (!data) return <Em />;
  const { sections, summary: s } = data;
  return (
    <div className="card overflow-hidden">
      <div className="px-6 py-3 border-b border-slate-800 flex items-center justify-between">
        <p className="text-2xs text-slate-500 font-mono">As of {ed}</p>
        {s.isBalanced?<span className="px-2 py-0.5 rounded text-xs bg-emerald-500/10 text-emerald-400">Balanced ✓</span>:<span className="px-2 py-0.5 rounded text-xs bg-red-500/10 text-red-400">Off by {formatMoney(Math.abs(s.varianceCents))}</span>}
      </div>
      <table className="w-full"><thead><tr className="border-b border-slate-800/50"><th className="px-6 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500 w-24">Acct</th><th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Description</th><th className="px-6 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500">Balance</th></tr></thead>
        <tbody>
          {sections.map((sec) => (<React.Fragment key={sec.type}>
            <tr className="bg-slate-800/30"><td colSpan={2} className="px-6 py-2 text-xs font-semibold text-slate-300 uppercase">{sec.label}</td><td className="px-6 py-2 text-right text-xs font-mono font-semibold text-slate-300">{formatMoney(sec.totalCents)}</td></tr>
            {sec.subTypes.flatMap((st) => st.groups.flatMap((g) => g.accounts.map((a) => (<tr key={a.accountNumber} onClick={() => onDrill({accountId:a.accountId,accountNumber:a.accountNumber,accountName:a.accountName})} className="cursor-pointer hover:bg-slate-800/40 transition-colors"><td className="px-6 py-1.5 text-xs font-mono text-slate-500 pl-10">{a.accountNumber}</td><td className="px-4 py-1.5 text-sm text-slate-400 flex items-center gap-1">{a.accountName}<ChevronRight size={10} className="text-slate-600"/></td><td className="px-6 py-1.5 text-right text-sm font-mono tabular-nums text-slate-300">{formatMoney(a.balanceCents)}</td></tr>))))}
          </React.Fragment>))}
          <tr className="bg-slate-800/30"><td/><td className="px-4 py-2.5 text-sm font-semibold text-white">Total Assets</td><td className="px-6 py-2.5 text-right text-base font-mono font-semibold text-white">{formatMoney(s.totalAssetsCents)}</td></tr>
          <tr className="bg-brand-500/[0.04]"><td/><td className="px-4 py-2.5 text-sm font-semibold text-white">Total L + E</td><td className="px-6 py-2.5 text-right text-base font-mono font-semibold text-white">{formatMoney(s.totalLiabilitiesCents+s.totalEquityCents)}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TRIAL BALANCE
// ═══════════════════════════════════════════════════════════════

function TbReport({ locId, onDrill }: { locId: string; onDrill: (t: DrillDownTarget) => void }) {
  const p: Record<string, string> = {};
  if (locId !== 'all') p.location_id = locId;
  const { data, isLoading, error } = useQuery<{ data: { account_number: string; account_name: string; account_type: string; total_debits: number; total_credits: number; net_balance: number }[] }>('/api/gl/trial-balance', p);
  if (isLoading) return <Ld />;
  if (error) return <Er m={String(error)} />;
  const rows = data?.data ?? [];
  if (!rows.length) return <Em m="No posted entries." />;
  const td = rows.reduce((s,r) => s+Number(r.total_debits),0);
  const tc = rows.reduce((s,r) => s+Number(r.total_credits),0);
  return (
    <div className="card overflow-hidden">
      <div className="px-6 py-3 border-b border-slate-800 flex items-center justify-between"><p className="text-2xs text-slate-500">{rows.length} accounts</p>{td===tc?<span className="px-2 py-0.5 rounded text-xs bg-emerald-500/10 text-emerald-400">Balanced ✓</span>:<span className="px-2 py-0.5 rounded text-xs bg-red-500/10 text-red-400">Unbalanced</span>}</div>
      <table className="w-full text-sm"><thead><tr className="border-b border-slate-800/50 text-2xs text-slate-500 uppercase"><th className="px-6 py-2.5 text-left w-20">Acct</th><th className="px-4 py-2.5 text-left">Name</th><th className="px-4 py-2.5 text-left w-16">Type</th><th className="px-6 py-2.5 text-right">Debits</th><th className="px-6 py-2.5 text-right">Credits</th><th className="px-6 py-2.5 text-right">Net</th></tr></thead>
        <tbody className="divide-y divide-slate-800/30">{rows.map((r) => (<tr key={r.account_number} onClick={() => onDrill({accountNumber:r.account_number,accountName:r.account_name})} className="cursor-pointer hover:bg-slate-800/40"><td className="px-6 py-1.5 text-xs font-mono text-slate-500">{r.account_number}</td><td className="px-4 py-1.5 text-slate-300">{r.account_name}</td><td className="px-4 py-1.5 text-2xs text-slate-500">{r.account_type}</td><td className="px-6 py-1.5 text-right font-mono text-slate-300">{Number(r.total_debits)>0?formatMoney(r.total_debits):''}</td><td className="px-6 py-1.5 text-right font-mono text-slate-300">{Number(r.total_credits)>0?formatMoney(r.total_credits):''}</td><td className="px-6 py-1.5 text-right font-mono font-medium text-slate-200">{formatMoney(r.net_balance)}</td></tr>))}</tbody>
        <tfoot><tr className="border-t-2 border-slate-700 bg-slate-800/30"><td colSpan={3} className="px-6 py-2.5 font-semibold text-white">Totals</td><td className="px-6 py-2.5 text-right font-mono font-semibold text-white">{formatMoney(td)}</td><td className="px-6 py-2.5 text-right font-mono font-semibold text-white">{formatMoney(tc)}</td><td className="px-6 py-2.5 text-right font-mono font-semibold text-white">{formatMoney(td-tc)}</td></tr></tfoot>
      </table>
    </div>
  );
}
