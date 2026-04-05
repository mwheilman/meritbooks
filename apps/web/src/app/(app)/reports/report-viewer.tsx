'use client';

import { useState, useMemo, useRef, useEffect } from 'react';
import React from 'react';
import { clsx } from 'clsx';
import {
  Download, Calendar, Building2, AlertCircle, Loader2, ChevronRight,
  FileText, Users, Briefcase, BarChart3, Shield, DollarSign,
  GitCompare, List, LayoutGrid, Sparkles, ChevronDown, Check,
  Landmark, PieChart, Filter
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
interface LocationEx extends Location { industry: string | null }

// ═══════════════════════════════════════════════════════════════
// MULTI-SELECT DROPDOWN COMPONENT
// ═══════════════════════════════════════════════════════════════

function MultiSelect({ label, icon: Icon, options, selected, onChange, allLabel }: {
  label: string;
  icon: React.ElementType;
  options: { value: string; label: string; group?: string }[];
  selected: string[];
  onChange: (v: string[]) => void;
  allLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const isAll = selected.length === 0;
  const displayText = isAll ? (allLabel ?? `All ${label}`) : selected.length === 1 ? options.find((o) => o.value === selected[0])?.label ?? '1 selected' : `${selected.length} selected`;

  const toggle = (val: string) => {
    if (selected.includes(val)) onChange(selected.filter((s) => s !== val));
    else onChange([...selected, val]);
  };

  // Group options if they have groups
  const groups = new Map<string, { value: string; label: string }[]>();
  for (const opt of options) {
    const g = opt.group ?? '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(opt);
  }

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white hover:border-slate-600 transition-colors">
        <Icon size={13} className="text-slate-500" />
        <span className={isAll ? 'text-slate-400' : 'text-emerald-400'}>{displayText}</span>
        <ChevronDown size={11} className="text-slate-500" />
      </button>

      {open && (
        <div className="absolute top-full mt-1 left-0 w-64 max-h-72 overflow-y-auto bg-slate-900 border border-slate-700 rounded-xl shadow-2xl z-50 py-1">
          {/* Select All / Clear */}
          <button onClick={() => onChange([])} className={clsx('w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-slate-800 transition-colors', isAll ? 'text-emerald-400' : 'text-slate-400')}>
            <div className={clsx('w-3.5 h-3.5 rounded border flex items-center justify-center', isAll ? 'bg-emerald-600 border-emerald-500' : 'border-slate-600')}>{isAll && <Check size={9} className="text-white" />}</div>
            {allLabel ?? `All ${label}`}
          </button>

          {Array.from(groups.entries()).map(([groupName, items]) => (
            <React.Fragment key={groupName}>
              {groupName && <div className="px-3 pt-2 pb-1 text-[10px] text-slate-600 uppercase tracking-wider">{groupName}</div>}
              {items.map((opt) => {
                const checked = selected.includes(opt.value);
                return (
                  <button key={opt.value} onClick={() => toggle(opt.value)} className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 transition-colors">
                    <div className={clsx('w-3.5 h-3.5 rounded border flex items-center justify-center', checked ? 'bg-emerald-600 border-emerald-500' : 'border-slate-600')}>{checked && <Check size={9} className="text-white" />}</div>
                    {opt.label}
                  </button>
                );
              })}
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// REPORT CATALOG
// ═══════════════════════════════════════════════════════════════

interface ReportDef { key: string; label: string; desc: string; needsDates: boolean; hasBasis: boolean; hasDetail: boolean; hasCompare: boolean }
interface ReportCategory { key: string; label: string; icon: React.ElementType; reports: ReportDef[] }

const CATALOG: ReportCategory[] = [
  { key: 'financial', label: 'Financial Statements', icon: FileText, reports: [
    { key: 'pnl', label: 'Profit & Loss', desc: 'Revenue minus expenses for a period', needsDates: true, hasBasis: true, hasDetail: true, hasCompare: true },
    { key: 'pnl_dept', label: 'P&L by Department', desc: 'Departmental breakdown', needsDates: true, hasBasis: true, hasDetail: true, hasCompare: false },
    { key: 'pnl_class', label: 'P&L by Class', desc: 'Class dimension filter', needsDates: true, hasBasis: true, hasDetail: true, hasCompare: false },
    { key: 'bs', label: 'Balance Sheet', desc: 'Assets, liabilities, equity at a point in time', needsDates: false, hasBasis: false, hasDetail: true, hasCompare: true },
    { key: 'cf', label: 'Cash Flow Statement', desc: 'Indirect method: operating, investing, financing', needsDates: true, hasBasis: false, hasDetail: false, hasCompare: false },
    { key: 'equity_changes', label: 'Changes in Equity', desc: 'Beginning + activity = ending per equity account', needsDates: true, hasBasis: false, hasDetail: false, hasCompare: false },
    { key: 'equity_table', label: 'Equity Table', desc: 'Current holders, ownership %, invested, distributions', needsDates: false, hasBasis: false, hasDetail: false, hasCompare: false },
    { key: 'debt', label: 'Debt Schedule', desc: 'All loans, lines of credit: balance, rate, maturity, payment', needsDates: false, hasBasis: false, hasDetail: false, hasCompare: false },
    { key: 'tb', label: 'Trial Balance', desc: 'All accounts with debit/credit balances', needsDates: false, hasBasis: false, hasDetail: false, hasCompare: false },
    { key: 'consol', label: 'Consolidated Statements', desc: 'Multi-entity P&L with IC eliminations', needsDates: true, hasBasis: false, hasDetail: false, hasCompare: false },
    { key: 'bva', label: 'Budget vs Actual', desc: 'Budget vs GL actuals with variance', needsDates: true, hasBasis: false, hasDetail: false, hasCompare: false },
  ]},
  { key: 'ar', label: 'Accounts Receivable', icon: DollarSign, reports: [
    { key: 'ar_aging', label: 'AR Aging', desc: 'Open invoices by aging bucket', needsDates: false, hasBasis: false, hasDetail: true, hasCompare: false },
    { key: 'inc_cust', label: 'Income by Customer', desc: 'Revenue and collections per customer', needsDates: true, hasBasis: false, hasDetail: true, hasCompare: false },
    { key: 'sales_cust', label: 'Sales by Customer', desc: 'Line-item sales breakdown per customer', needsDates: true, hasBasis: false, hasDetail: true, hasCompare: false },
    { key: 'cust_bal', label: 'Customer Balances', desc: 'Open balance per customer', needsDates: false, hasBasis: false, hasDetail: false, hasCompare: false },
    { key: 'open_ar', label: 'Open Invoices', desc: 'All unpaid invoices with days overdue', needsDates: false, hasBasis: false, hasDetail: false, hasCompare: false },
  ]},
  { key: 'ap', label: 'Accounts Payable', icon: Users, reports: [
    { key: 'ap_aging', label: 'AP Aging', desc: 'Open bills by aging bucket', needsDates: false, hasBasis: false, hasDetail: true, hasCompare: false },
    { key: 'exp_vend', label: 'Expense by Vendor', desc: 'All expenses grouped by vendor', needsDates: true, hasBasis: false, hasDetail: true, hasCompare: false },
    { key: 'vend_bal', label: 'Vendor Balances', desc: 'Open balance per vendor', needsDates: false, hasBasis: false, hasDetail: false, hasCompare: false },
    { key: 'open_ap', label: 'Open Bills', desc: 'All unpaid bills', needsDates: false, hasBasis: false, hasDetail: false, hasCompare: false },
    { key: 'vendor_1099', label: '1099 Summary', desc: '1099-eligible vendors with YTD payments', needsDates: true, hasBasis: false, hasDetail: true, hasCompare: false },
  ]},
  { key: 'jobs', label: 'Jobs & Projects', icon: Briefcase, reports: [
    { key: 'job_prof', label: 'Job Profitability', desc: 'Contract, cost, billed, margin per job', needsDates: false, hasBasis: false, hasDetail: false, hasCompare: false },
    { key: 'wip', label: 'WIP Schedule', desc: 'Work in progress over/under billed', needsDates: false, hasBasis: false, hasDetail: false, hasCompare: false },
    { key: 'job_cost', label: 'Job Cost Detail', desc: 'Costs by job, phase, cost code', needsDates: true, hasBasis: false, hasDetail: true, hasCompare: false },
  ]},
  { key: 'mgmt', label: 'Management', icon: BarChart3, reports: [
    { key: 'gl', label: 'General Ledger', desc: 'Every GL transaction by date range', needsDates: true, hasBasis: false, hasDetail: false, hasCompare: false },
    { key: 'gl_compare', label: 'GL Account Comparison', desc: 'Compare any account across two periods', needsDates: true, hasBasis: false, hasDetail: false, hasCompare: true },
    { key: 'txn_list', label: 'Transaction List', desc: 'All transactions by date', needsDates: true, hasBasis: false, hasDetail: true, hasCompare: false },
    { key: 'open', label: 'Open Items (AR+AP)', desc: 'Combined unpaid invoices and bills', needsDates: false, hasBasis: false, hasDetail: false, hasCompare: false },
  ]},
  { key: 'tax', label: 'Tax & Compliance', icon: Shield, reports: [
    { key: 'sales_tax', label: 'Sales Tax Summary', desc: 'Tax collected by jurisdiction', needsDates: true, hasBasis: false, hasDetail: true, hasCompare: false },
  ]},
];

// ═══════════════════════════════════════════════════════════════
// PERIOD PRESETS
// ═══════════════════════════════════════════════════════════════

function pad(n: number) { return String(n).padStart(2, '0'); }
function fmt(d: Date) { return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }

const PERIODS = [
  { key: 'this_month', label: 'This Month', get: () => { const n = new Date(); return { s: `${n.getFullYear()}-${pad(n.getMonth()+1)}-01`, e: fmt(new Date(n.getFullYear(), n.getMonth()+1, 0)) }; }},
  { key: 'last_month', label: 'Last Month', get: () => { const n = new Date(); const d = new Date(n.getFullYear(), n.getMonth()-1, 1); return { s: fmt(d), e: fmt(new Date(d.getFullYear(), d.getMonth()+1, 0)) }; }},
  { key: 'this_qtr', label: 'This Quarter', get: () => { const n = new Date(); const q = Math.floor(n.getMonth()/3)*3; return { s: `${n.getFullYear()}-${pad(q+1)}-01`, e: fmt(new Date(n.getFullYear(), q+3, 0)) }; }},
  { key: 'last_qtr', label: 'Last Quarter', get: () => { const n = new Date(); let q = Math.floor(n.getMonth()/3)*3-3; let y = n.getFullYear(); if(q<0){q+=12;y--;} return { s: `${y}-${pad(q+1)}-01`, e: fmt(new Date(y, q+3, 0)) }; }},
  { key: 'ytd', label: 'Year to Date', get: () => ({ s: `${new Date().getFullYear()}-01-01`, e: fmt(new Date()) })},
  { key: 'ytd_closed', label: 'YTD Through Last Month', get: () => { const n = new Date(); const e = new Date(n.getFullYear(), n.getMonth(), 0); return { s: `${n.getFullYear()}-01-01`, e: fmt(e) }; }},
  { key: 'last_year', label: 'Last Year', get: () => { const y = new Date().getFullYear()-1; return { s: `${y}-01-01`, e: `${y}-12-31` }; }},
  { key: 'last_12', label: 'Last 12 Months', get: () => { const n = new Date(); const s = new Date(n.getFullYear()-1, n.getMonth(), n.getDate()+1); return { s: fmt(s), e: fmt(n) }; }},
  { key: 'custom', label: 'Custom Range', get: () => ({ s: '', e: '' })},
];

// ═══════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════

export function ReportViewer() {
  const [catKey, setCatKey] = useState('financial');
  const [reportKey, setReportKey] = useState<string | null>(null);
  const [periodKey, setPeriodKey] = useState('this_month');
  const [customS, setCustomS] = useState('');
  const [customE, setCustomE] = useState('');
  const [selectedLocs, setSelectedLocs] = useState<string[]>([]);
  const [selectedIndustries, setSelectedIndustries] = useState<string[]>([]);
  const [selectedDepts, setSelectedDepts] = useState<string[]>([]);
  const [basis, setBasis] = useState<'accrual'|'cash'>('accrual');
  const [viewMode, setViewMode] = useState<'summary'|'detail'>('summary');
  const [compare, setCompare] = useState(false);
  const [drill, setDrill] = useState<DrillDownTarget | null>(null);
  const [nlQuery, setNlQuery] = useState('');

  // Fetch locations for filter dropdowns
  const { data: rawLocs } = useQuery<LocationEx[]>('/api/locations');
  const locations = rawLocs ?? [];

  // Fetch departments
  const { data: deptData } = useQuery<{ data: { id: string; name: string; code: string }[] }>('/api/locations'); // Would be /api/departments — use locations as proxy for now

  // Derive industries from locations
  const industries = useMemo(() => {
    const set = new Set(locations.map((l) => l.industry).filter(Boolean) as string[]);
    return Array.from(set).sort();
  }, [locations]);

  // Apply industry filter to auto-select matching locations
  useEffect(() => {
    if (selectedIndustries.length > 0) {
      const matchingLocIds = locations
        .filter((l) => l.industry && selectedIndustries.includes(l.industry))
        .map((l) => l.id);
      setSelectedLocs(matchingLocIds);
    }
  }, [selectedIndustries, locations]);

  // Compute dates
  const { s: sd, e: ed } = useMemo(() => {
    if (periodKey === 'custom') return { s: customS, e: customE };
    return PERIODS.find((p) => p.key === periodKey)?.get() ?? { s: '', e: '' };
  }, [periodKey, customS, customE]);

  // Find report def
  const reportDef = useMemo(() => {
    for (const cat of CATALOG) { const r = cat.reports.find((r) => r.key === reportKey); if (r) return r; }
    return null;
  }, [reportKey]);

  const currentCat = CATALOG.find((c) => c.key === catKey);

  // Build location_ids param (comma-separated for multi-select)
  const locIdsParam = selectedLocs.length > 0 ? selectedLocs.join(',') : '';

  // Company options for multi-select
  const companyOptions = useMemo(() =>
    locations.map((l) => ({ value: l.id, label: `${l.short_code} · ${l.name}`, group: l.industry ?? 'Other' })),
    [locations]
  );

  const industryOptions = useMemo(() =>
    industries.map((i) => ({ value: i, label: i })),
    [industries]
  );

  return (
    <div className="flex gap-6 h-[calc(100vh-140px)]">
      {/* ─── Sidebar ─── */}
      <div className="w-60 shrink-0 overflow-y-auto">
        <div className="relative mb-4">
          <Sparkles className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-indigo-400" />
          <input type="text" placeholder="Ask for any report..." value={nlQuery} onChange={(e) => setNlQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2.5 bg-indigo-500/[0.06] border border-indigo-500/20 rounded-xl text-sm text-white placeholder:text-indigo-300/40 focus:outline-none focus:border-indigo-500/40" />
        </div>
        <nav className="space-y-0.5">
          {CATALOG.map((cat) => {
            const Icon = cat.icon;
            const active = catKey === cat.key;
            return (
              <div key={cat.key}>
                <button onClick={() => { setCatKey(cat.key); setReportKey(null); }}
                  className={clsx('w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors text-left',
                    active ? 'bg-emerald-500/10 text-emerald-400' : 'text-slate-400 hover:text-white hover:bg-slate-800/50')}>
                  <Icon className="w-4 h-4 shrink-0" />{cat.label}
                  <ChevronDown className={clsx('w-3 h-3 ml-auto transition-transform', active ? '' : '-rotate-90')} />
                </button>
                {active && (
                  <div className="ml-6 mt-0.5 space-y-0.5 border-l border-slate-800 pl-3">
                    {cat.reports.map((r) => (
                      <button key={r.key} onClick={() => setReportKey(r.key)}
                        className={clsx('w-full text-left px-2.5 py-1.5 rounded-md text-xs transition-colors',
                          reportKey === r.key ? 'bg-slate-800 text-white font-medium' : 'text-slate-500 hover:text-slate-300')}>
                        {r.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
      </div>

      {/* ─── Content ─── */}
      <div className="flex-1 overflow-y-auto">
        {!reportKey ? (
          <div>
            <h1 className="text-2xl font-semibold text-white mb-2">{currentCat?.label ?? 'Reports'}</h1>
            <p className="text-sm text-slate-400 mb-6">Select a report to generate.</p>
            <div className="grid grid-cols-2 gap-3">
              {(currentCat?.reports ?? []).map((r) => (
                <button key={r.key} onClick={() => setReportKey(r.key)}
                  className="text-left p-4 rounded-xl border border-slate-800 bg-slate-800/20 hover:bg-slate-800/50 hover:border-slate-700 transition-colors group">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium text-white group-hover:text-emerald-400 transition-colors">{r.label}</span>
                    <ChevronRight className="w-4 h-4 text-slate-600 group-hover:text-emerald-400" />
                  </div>
                  <p className="text-xs text-slate-500">{r.desc}</p>
                  <div className="flex gap-1.5 mt-2">
                    {r.hasBasis && <span className="px-1.5 py-0.5 text-[10px] rounded bg-cyan-500/10 text-cyan-400">Cash/Accrual</span>}
                    {r.hasDetail && <span className="px-1.5 py-0.5 text-[10px] rounded bg-purple-500/10 text-purple-400">Sum/Detail</span>}
                    {r.hasCompare && <span className="px-1.5 py-0.5 text-[10px] rounded bg-amber-500/10 text-amber-400">Compare</span>}
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div>
            <div className="flex items-start justify-between mb-4">
              <div><h1 className="text-xl font-semibold text-white">{reportDef?.label}</h1><p className="text-xs text-slate-500 mt-0.5">{reportDef?.desc}</p></div>
              <button className="btn-secondary btn-sm flex items-center gap-1.5"><Download size={14} />Export</button>
            </div>

            {/* ─── Controls Bar ─── */}
            <div className="flex items-center gap-2 mb-5 p-3 rounded-xl bg-slate-800/20 border border-slate-800 flex-wrap">
              {/* Period */}
              {reportDef?.needsDates !== false && (
                <div className="flex items-center gap-1.5">
                  <Calendar size={13} className="text-slate-500" />
                  <select value={periodKey} onChange={(e) => setPeriodKey(e.target.value)} className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white">
                    {PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                  </select>
                  {periodKey === 'custom' && <>
                    <input type="date" value={customS} onChange={(e) => setCustomS(e.target.value)} className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white font-mono w-32" />
                    <span className="text-slate-600 text-xs">to</span>
                    <input type="date" value={customE} onChange={(e) => setCustomE(e.target.value)} className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white font-mono w-32" />
                  </>}
                </div>
              )}

              {/* Multi-select: Companies */}
              <MultiSelect label="Companies" icon={Building2} options={companyOptions} selected={selectedLocs} onChange={setSelectedLocs} allLabel="All Companies" />

              {/* Multi-select: Industries */}
              {industries.length > 0 && (
                <MultiSelect label="Industries" icon={Briefcase} options={industryOptions} selected={selectedIndustries} onChange={setSelectedIndustries} allLabel="All Industries" />
              )}

              {/* Cash/Accrual */}
              {reportDef?.hasBasis && (
                <div className="flex gap-0.5 p-0.5 rounded-lg bg-slate-900 border border-slate-700">
                  <button onClick={() => setBasis('accrual')} className={clsx('px-2.5 py-1 rounded-md text-xs font-medium', basis==='accrual' ? 'bg-slate-700 text-white' : 'text-slate-500')}>Accrual</button>
                  <button onClick={() => setBasis('cash')} className={clsx('px-2.5 py-1 rounded-md text-xs font-medium', basis==='cash' ? 'bg-slate-700 text-white' : 'text-slate-500')}>Cash</button>
                </div>
              )}

              {/* Summary/Detail */}
              {reportDef?.hasDetail && (
                <div className="flex gap-0.5 p-0.5 rounded-lg bg-slate-900 border border-slate-700">
                  <button onClick={() => setViewMode('summary')} className={clsx('px-2 py-1 rounded-md text-xs flex items-center gap-1', viewMode==='summary'?'bg-slate-700 text-white':'text-slate-500')}><LayoutGrid size={11}/>Summary</button>
                  <button onClick={() => setViewMode('detail')} className={clsx('px-2 py-1 rounded-md text-xs flex items-center gap-1', viewMode==='detail'?'bg-slate-700 text-white':'text-slate-500')}><List size={11}/>Detail</button>
                </div>
              )}

              {/* Compare */}
              {reportDef?.hasCompare && (
                <button onClick={() => setCompare(!compare)} className={clsx('flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border', compare ? 'bg-indigo-600/20 text-indigo-400 border-indigo-500/30' : 'bg-slate-800 text-slate-400 border-slate-700')}>
                  <GitCompare size={11}/>{compare ? 'Comparing' : 'Compare'}
                </button>
              )}
            </div>

            {/* Report content */}
            <ReportContent reportKey={reportKey} sd={sd} ed={ed} locIds={locIdsParam} basis={basis} viewMode={viewMode} compare={compare} onDrill={setDrill} />
          </div>
        )}
      </div>

      {drill && <GlDrillDown accountId={drill.accountId} accountNumber={drill.accountNumber} accountName={drill.accountName} startDate={sd} endDate={ed} locationId={selectedLocs[0] ?? 'all'} onClose={() => setDrill(null)} />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// REPORT CONTENT ROUTER
// ═══════════════════════════════════════════════════════════════

function ReportContent({ reportKey, sd, ed, locIds, basis, viewMode, compare, onDrill }: {
  reportKey: string; sd: string; ed: string; locIds: string; basis: string; viewMode: string; compare: boolean; onDrill: (t: DrillDownTarget) => void;
}) {
  const p: Record<string, string> = {};
  if (sd) p.start_date = sd;
  if (ed) p.end_date = ed;
  // For multi-select: APIs that take location_id get the first one, APIs that take location_ids get all
  const firstLoc = locIds.split(',')[0] ?? '';
  if (firstLoc) p.location_id = firstLoc;

  switch (reportKey) {
    case 'pnl': return <PnlReport p={p} onDrill={onDrill} compare={compare} />;
    case 'bs': return <BsReport ed={ed} locId={firstLoc || 'all'} onDrill={onDrill} />;
    case 'cf': return <CashFlowReport startDate={sd} endDate={ed} locationId={firstLoc || 'all'} />;
    case 'tb': return <TbReport locId={firstLoc || 'all'} onDrill={onDrill} />;
    case 'debt': return <GenericReport url="/api/reports/debt-schedule" params={{ location_ids: locIds }} title="Debt Schedule" />;
    case 'equity_table': return <GenericReport url="/api/reports/equity-table" params={{ location_ids: locIds }} title="Equity Table" />;
    case 'equity_changes': return <GenericReport url="/api/reports/equity-changes" params={p} title="Changes in Equity" />;
    default: {
      // Generic API report for everything else
      const url = reportKey === 'gl' ? '/api/reports/gl-detail' :
        reportKey === 'ar_aging' ? '/api/reports/ar-aging' :
        reportKey === 'ap_aging' ? '/api/reports/ap-aging' :
        reportKey === 'job_prof' ? '/api/reports/job-profitability' :
        reportKey === 'bva' ? '/api/budgets/vs-actual' :
        reportKey === 'consol' ? '/api/reports/consolidated' :
        reportKey === 'inc_cust' ? '/api/reports/income-by-customer' :
        reportKey === 'sales_cust' ? '/api/reports/sales-by-customer' :
        reportKey === 'exp_vend' ? '/api/reports/expense-by-vendor' :
        reportKey === 'vend_bal' ? '/api/reports/vendor-balances' :
        reportKey === 'cust_bal' ? '/api/reports/customer-balances' :
        reportKey === 'open' || reportKey === 'open_ar' || reportKey === 'open_ap' ? '/api/reports/open-items' :
        reportKey === 'txn_list' ? '/api/reports/transaction-list' :
        null;
      if (!url) return <div className="card p-8 text-center text-slate-500">Report not yet implemented.</div>;
      const params = { ...p, mode: viewMode };
      if (reportKey === 'bva') params.fiscal_year = sd?.slice(0,4) ?? '';
      if (reportKey === 'open_ar') params.type = 'ar';
      if (reportKey === 'open_ap') params.type = 'ap';
      return <GenericReport url={url} params={params} title={reportKey} />;
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// SHARED
// ═══════════════════════════════════════════════════════════════

function Ld() { return <div className="card p-12 flex items-center justify-center"><Loader2 size={24} className="animate-spin text-slate-500" /></div>; }
function Er({ m }: { m: string }) { return <div className="card p-8 text-center"><AlertCircle size={24} className="mx-auto text-red-400 mb-2" /><p className="text-sm text-red-400">{m}</p></div>; }
function Em({ m }: { m?: string }) { return <div className="card p-8 text-center text-sm text-slate-500">{m ?? 'No data. This report populates as transactions are posted.'}</div>; }

function GenericReport({ url, params, title }: { url: string; params: Record<string, string>; title: string }) {
  const clean = Object.fromEntries(Object.entries(params).filter(([,v]) => v));
  const qs = new URLSearchParams(clean).toString();
  const { data, isLoading, error } = useQuery<any>(`${url}${qs ? '?'+qs : ''}`);
  if (isLoading) return <Ld />;
  if (error) return <Er m={String(error)} />;
  if (!data) return <Em />;
  const rows = data.data ?? data.accounts ?? data.reconciliations ?? [];
  if (!Array.isArray(rows) || rows.length === 0) return <Em m={`No data found.`} />;
  const keys = Object.keys(rows[0]).filter((k) => !k.includes('Id') && !k.includes('id') && k !== 'transactions' && k !== 'invoices' && k !== 'details' && k !== 'aging' && k !== 'accounts' && k !== 'byAccount' && k !== 'byLocation');
  return (
    <div className="card overflow-hidden">
      <div className="px-6 py-3 border-b border-slate-800"><p className="text-2xs text-slate-500">{rows.length} rows</p></div>
      <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-slate-800/50">
        {keys.map((k) => <th key={k} className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500 whitespace-nowrap">{k.replace(/([A-Z])/g,' $1').replace(/Cents$/,'').trim()}</th>)}
      </tr></thead><tbody className="divide-y divide-slate-800/30">
        {rows.slice(0,200).map((row: any, i: number) => (<tr key={i} className="hover:bg-slate-800/20">{keys.map((k) => { const v = row[k]; const m = typeof k==='string'&&(k.endsWith('Cents')||k.includes('cents')); const b = typeof v==='boolean'; const pct = typeof k==='string'&&(k.includes('Pct')||k.includes('Rate')); return <td key={k} className={clsx('px-4 py-1.5 whitespace-nowrap',m||pct?'text-right font-mono':'',m?'text-slate-200':'text-slate-400')}>{m?formatMoney(Number(v??0)):b?(v?'✓':'—'):pct?`${v}%`:String(v??'—')}</td>; })}</tr>))}
      </tbody></table></div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// P&L, BS, TB (with drill-down)
// ═══════════════════════════════════════════════════════════════

interface ISAcct { accountId: string; accountNumber: string; accountName: string; amountCents: number }
interface ISGroup { name: string; accounts: ISAcct[]; totalCents: number }
interface ISSection { type: string; label: string; groups: ISGroup[]; totalCents: number }
interface ISR { sections: ISSection[]; summary: { revenueCents: number; grossProfitCents: number; netIncomeCents: number; grossMarginPct: number; netMarginPct: number } }

function PnlReport({ p, onDrill, compare }: { p: Record<string, string>; onDrill: (t: DrillDownTarget) => void; compare: boolean }) {
  const { data, isLoading, error } = useQuery<ISR>('/api/reports/income-statement', p);
  const pe = p.start_date ? new Date(p.start_date) : new Date(); pe.setDate(pe.getDate()-1);
  const pp = { ...p, start_date: `${pe.getFullYear()}-${pad(pe.getMonth()+1)}-01`, end_date: fmt(pe) };
  const { data: pd } = useQuery<ISR>(compare ? '/api/reports/income-statement' : null, compare ? pp : undefined);
  if (isLoading) return <Ld />; if (error) return <Er m={String(error)} />; if (!data) return <Em />;
  const { sections, summary: s } = data; const rb = Math.abs(s.revenueCents)||1;
  const pm = new Map<string,number>(); if(pd) pd.sections.forEach(sec => sec.groups.forEach(g => g.accounts.forEach(a => pm.set(a.accountNumber,a.amountCents))));
  return (
    <div className="card overflow-hidden"><table className="w-full"><thead><tr className="border-b border-slate-800/50"><th className="px-6 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500 w-24">Acct</th><th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Description</th><th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500">Amount</th><th className="px-3 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500 w-12">%</th>{compare&&<><th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500">Prior</th><th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500">Var</th></>}</tr></thead><tbody>
      {sections.map(sec => (<React.Fragment key={sec.type}><tr className="bg-slate-800/30"><td colSpan={compare?6:4} className="px-6 py-2 text-xs font-semibold text-slate-300 uppercase">{sec.label} <span className="font-mono text-slate-500 ml-1">{formatMoney(sec.totalCents)}</span></td></tr>
        {sec.groups.flatMap(g => g.accounts.map(a => { const pv=pm.get(a.accountNumber)??0; const v=a.amountCents-pv; return <tr key={a.accountNumber} onClick={() => onDrill({accountId:a.accountId,accountNumber:a.accountNumber,accountName:a.accountName})} className="cursor-pointer hover:bg-slate-800/40"><td className="px-6 py-1.5 text-xs font-mono text-slate-500 pl-10">{a.accountNumber}</td><td className="px-4 py-1.5 text-sm text-slate-300 flex items-center gap-1">{a.accountName}<ChevronRight size={10} className="text-slate-600"/></td><td className="px-4 py-1.5 text-right text-sm font-mono text-slate-200">{formatMoney(a.amountCents)}</td><td className="px-3 py-1.5 text-right text-2xs font-mono text-slate-600">{Math.round(Math.abs(a.amountCents)/rb*100)}%</td>{compare&&<><td className="px-4 py-1.5 text-right text-sm font-mono text-slate-400">{formatMoney(pv)}</td><td className={clsx('px-4 py-1.5 text-right text-sm font-mono',v>0?'text-emerald-400':v<0?'text-red-400':'text-slate-500')}>{v>0?'+':''}{formatMoney(v)}</td></>}</tr>; }))}
      </React.Fragment>))}
      <tr className="bg-slate-800/20"><td/><td className="px-4 py-2.5 text-sm font-semibold text-white">Gross Profit</td><td className="px-4 py-2.5 text-right font-mono font-semibold text-white">{formatMoney(s.grossProfitCents)} <span className="text-2xs text-slate-500">{s.grossMarginPct}%</span></td><td/>{compare&&<td colSpan={2}/>}</tr>
      <tr className="bg-brand-500/[0.04]"><td/><td className="px-4 py-2.5 text-sm font-semibold text-white">Net Income</td><td className={clsx('px-4 py-2.5 text-right font-mono font-semibold',s.netIncomeCents>=0?'text-emerald-400':'text-red-400')}>{formatMoney(s.netIncomeCents)} <span className="text-2xs text-slate-500">{s.netMarginPct}%</span></td><td/>{compare&&<td colSpan={2}/>}</tr>
    </tbody></table></div>
  );
}

function BsReport({ ed, locId, onDrill }: { ed: string; locId: string; onDrill: (t: DrillDownTarget) => void }) {
  const p: Record<string,string> = { as_of_date: ed }; if (locId!=='all') p.location_id=locId;
  const { data, isLoading, error } = useQuery<{ sections: { type: string; label: string; subTypes: { groups: { accounts: { accountId: string; accountNumber: string; accountName: string; balanceCents: number }[] }[] }[]; totalCents: number }[]; summary: { totalAssetsCents: number; totalLiabilitiesCents: number; totalEquityCents: number; isBalanced: boolean; varianceCents: number } }>('/api/reports/balance-sheet', p);
  if (isLoading) return <Ld />; if (error) return <Er m={String(error)} />; if (!data) return <Em />;
  const { sections, summary: s } = data;
  return (
    <div className="card overflow-hidden">
      <div className="px-6 py-3 border-b border-slate-800 flex items-center justify-between"><p className="text-2xs text-slate-500 font-mono">As of {ed}</p>{s.isBalanced?<span className="px-2 py-0.5 rounded text-xs bg-emerald-500/10 text-emerald-400">Balanced ✓</span>:<span className="px-2 py-0.5 rounded text-xs bg-red-500/10 text-red-400">Off by {formatMoney(Math.abs(s.varianceCents))}</span>}</div>
      <table className="w-full"><thead><tr className="border-b border-slate-800/50"><th className="px-6 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500 w-24">Acct</th><th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Description</th><th className="px-6 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500">Balance</th></tr></thead><tbody>
        {sections.map(sec => (<React.Fragment key={sec.type}><tr className="bg-slate-800/30"><td colSpan={2} className="px-6 py-2 text-xs font-semibold text-slate-300 uppercase">{sec.label}</td><td className="px-6 py-2 text-right text-xs font-mono font-semibold text-slate-300">{formatMoney(sec.totalCents)}</td></tr>
          {sec.subTypes.flatMap(st => st.groups.flatMap(g => g.accounts.map(a => <tr key={a.accountNumber} onClick={() => onDrill({accountId:a.accountId,accountNumber:a.accountNumber,accountName:a.accountName})} className="cursor-pointer hover:bg-slate-800/40"><td className="px-6 py-1.5 text-xs font-mono text-slate-500 pl-10">{a.accountNumber}</td><td className="px-4 py-1.5 text-sm text-slate-400 flex items-center gap-1">{a.accountName}<ChevronRight size={10} className="text-slate-600"/></td><td className="px-6 py-1.5 text-right text-sm font-mono text-slate-300">{formatMoney(a.balanceCents)}</td></tr>)))}
        </React.Fragment>))}
        <tr className="bg-slate-800/30"><td/><td className="px-4 py-2.5 text-sm font-semibold text-white">Total Assets</td><td className="px-6 py-2.5 text-right text-base font-mono font-semibold text-white">{formatMoney(s.totalAssetsCents)}</td></tr>
        <tr className="bg-brand-500/[0.04]"><td/><td className="px-4 py-2.5 text-sm font-semibold text-white">Total L + E</td><td className="px-6 py-2.5 text-right text-base font-mono font-semibold text-white">{formatMoney(s.totalLiabilitiesCents+s.totalEquityCents)}</td></tr>
      </tbody></table>
    </div>
  );
}

function TbReport({ locId, onDrill }: { locId: string; onDrill: (t: DrillDownTarget) => void }) {
  const p: Record<string,string> = {}; if (locId!=='all') p.location_id=locId;
  const { data, isLoading, error } = useQuery<{ data: { account_number: string; account_name: string; account_type: string; total_debits: number; total_credits: number; net_balance: number }[] }>('/api/gl/trial-balance', p);
  if (isLoading) return <Ld />; if (error) return <Er m={String(error)} />;
  const rows = data?.data ?? []; if (!rows.length) return <Em m="No posted entries." />;
  const td=rows.reduce((s,r) => s+Number(r.total_debits),0); const tc=rows.reduce((s,r) => s+Number(r.total_credits),0);
  return (
    <div className="card overflow-hidden">
      <div className="px-6 py-3 border-b border-slate-800 flex items-center justify-between"><p className="text-2xs text-slate-500">{rows.length} accounts</p>{td===tc?<span className="px-2 py-0.5 rounded text-xs bg-emerald-500/10 text-emerald-400">Balanced ✓</span>:<span className="px-2 py-0.5 rounded text-xs bg-red-500/10 text-red-400">Unbalanced</span>}</div>
      <table className="w-full text-sm"><thead><tr className="border-b border-slate-800/50 text-2xs text-slate-500 uppercase"><th className="px-6 py-2.5 text-left w-20">Acct</th><th className="px-4 py-2.5 text-left">Name</th><th className="px-4 py-2.5 text-left w-16">Type</th><th className="px-6 py-2.5 text-right">Debits</th><th className="px-6 py-2.5 text-right">Credits</th><th className="px-6 py-2.5 text-right">Net</th></tr></thead>
        <tbody className="divide-y divide-slate-800/30">{rows.map(r => <tr key={r.account_number} onClick={() => onDrill({accountNumber:r.account_number,accountName:r.account_name})} className="cursor-pointer hover:bg-slate-800/40"><td className="px-6 py-1.5 text-xs font-mono text-slate-500">{r.account_number}</td><td className="px-4 py-1.5 text-slate-300">{r.account_name}</td><td className="px-4 py-1.5 text-2xs text-slate-500">{r.account_type}</td><td className="px-6 py-1.5 text-right font-mono text-slate-300">{Number(r.total_debits)>0?formatMoney(r.total_debits):''}</td><td className="px-6 py-1.5 text-right font-mono text-slate-300">{Number(r.total_credits)>0?formatMoney(r.total_credits):''}</td><td className="px-6 py-1.5 text-right font-mono font-medium text-slate-200">{formatMoney(r.net_balance)}</td></tr>)}</tbody>
        <tfoot><tr className="border-t-2 border-slate-700 bg-slate-800/30"><td colSpan={3} className="px-6 py-2.5 font-semibold text-white">Totals</td><td className="px-6 py-2.5 text-right font-mono font-semibold text-white">{formatMoney(td)}</td><td className="px-6 py-2.5 text-right font-mono font-semibold text-white">{formatMoney(tc)}</td><td className="px-6 py-2.5 text-right font-mono font-semibold text-white">{formatMoney(td-tc)}</td></tr></tfoot>
      </table>
    </div>
  );
}
