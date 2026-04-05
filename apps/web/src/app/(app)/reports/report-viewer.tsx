'use client';

import { useState, useMemo } from 'react';
import React from 'react';
import { clsx } from 'clsx';
import { Download, Calendar, Building2, AlertCircle, Loader2, ChevronRight, ChevronDown, GitCompare } from 'lucide-react';
import { useQuery } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import type { Location } from '@meritbooks/shared';
import { CashFlowReport } from './cash-flow-report';
import { GlDrillDown } from './gl-drill-down';

// ===== Shared Types =====
interface DrillDownTarget { accountId?: string; accountNumber: string; accountName: string }
interface AgingRow { vendorName?: string; customerName?: string; billNumber?: string; invoiceNumber?: string; dueDate: string; totalCents: number; balanceCents: number; agingBucket: string; locationName: string }
interface AgingResponse { data: AgingRow[]; buckets: Record<string, { count: number; totalCents: number }>; totalOutstanding: number }

// ===== Report Tabs (16 total) =====
const REPORT_TABS = [
  { key: 'pnl', label: 'P&L' },
  { key: 'bs', label: 'Balance Sheet' },
  { key: 'cf', label: 'Cash Flow' },
  { key: 'tb', label: 'Trial Balance' },
  { key: 'gl', label: 'GL Detail' },
  { key: 'ar_aging', label: 'AR Aging' },
  { key: 'ap_aging', label: 'AP Aging' },
  { key: 'job_prof', label: 'Job Profit' },
  { key: 'bva', label: 'Budget v Actual' },
  { key: 'consol', label: 'Consolidated' },
  { key: 'equity', label: 'Equity Changes' },
  { key: 'vend_bal', label: 'Vendor Bal' },
  { key: 'cust_bal', label: 'Customer Bal' },
  { key: 'open', label: 'Open Items' },
  { key: 'exp_vend', label: 'Expense/Vendor' },
  { key: 'inc_cust', label: 'Income/Customer' },
  { key: 'sales_cust', label: 'Sales/Customer' },
  { key: 'txn_list', label: 'Transactions' },
] as const;

type RT = (typeof REPORT_TABS)[number]['key'];

function getDefaults() {
  const n = new Date();
  return { start: `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-01`, end: new Date(n.getFullYear(), n.getMonth()+1, 0).toISOString().slice(0,10) };
}

// ===== Main =====
export function ReportViewer() {
  const [tab, setTab] = useState<RT>('pnl');
  const d = useMemo(getDefaults, []);
  const [sd, setSd] = useState(d.start);
  const [ed, setEd] = useState(d.end);
  const [locId, setLocId] = useState('all');
  const [drill, setDrill] = useState<DrillDownTarget | null>(null);
  const [compare, setCompare] = useState(false);

  const { data: locs } = useQuery<Location[]>('/api/locations');

  return (
    <div>
      <div className="flex items-center gap-0.5 p-1 rounded-lg bg-surface-900 border border-slate-800 w-fit mb-4 overflow-x-auto">
        {REPORT_TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={clsx('px-2.5 py-1.5 rounded-md text-xs transition-colors whitespace-nowrap',
              tab === t.key ? 'bg-slate-800 text-white font-medium' : 'text-slate-400 hover:text-slate-300')}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-3 mb-6 flex-wrap">
        <div className="flex items-center gap-2">
          <Calendar size={14} className="text-slate-500" />
          <input type="date" value={sd} onChange={(e) => setSd(e.target.value)} className="input w-36 text-sm font-mono" />
          <span className="text-slate-600 text-sm">to</span>
          <input type="date" value={ed} onChange={(e) => setEd(e.target.value)} className="input w-36 text-sm font-mono" />
        </div>
        <div className="flex items-center gap-2">
          <Building2 size={14} className="text-slate-500" />
          <select value={locId} onChange={(e) => setLocId(e.target.value)} className="input w-52">
            <option value="all">All Companies</option>
            {(locs ?? []).map((l) => <option key={l.id} value={l.id}>{l.short_code} · {l.name}</option>)}
          </select>
        </div>
        {(tab === 'pnl' || tab === 'bs') && (
          <button onClick={() => setCompare(!compare)} className={clsx('flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors', compare ? 'bg-indigo-600/20 text-indigo-400 border-indigo-500/30' : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-white')}>
            <GitCompare size={12} /> {compare ? 'Comparing' : 'Compare'}
          </button>
        )}
        <button className="btn-secondary btn-sm ml-auto flex items-center gap-1.5"><Download size={14} />Export</button>
      </div>

      {tab === 'pnl' && <PnlReport sd={sd} ed={ed} locId={locId} onDrill={setDrill} compare={compare} />}
      {tab === 'bs' && <BsReport ed={ed} locId={locId} onDrill={setDrill} />}
      {tab === 'cf' && <CashFlowReport startDate={sd} endDate={ed} locationId={locId} />}
      {tab === 'tb' && <TbReport locId={locId} onDrill={setDrill} />}
      {tab === 'gl' && <GlReport sd={sd} ed={ed} locId={locId} />}
      {tab === 'ar_aging' && <AgingReport type="ar" locId={locId} />}
      {tab === 'ap_aging' && <AgingReport type="ap" locId={locId} />}
      {tab === 'job_prof' && <JobProfReport locId={locId} />}
      {tab === 'bva' && <BvaReport sd={sd} ed={ed} locId={locId} />}
      {tab === 'consol' && <ConsolReport sd={sd} ed={ed} />}
      {tab === 'equity' && <EquityReport sd={sd} ed={ed} locId={locId} />}
      {tab === 'vend_bal' && <VendBalReport locId={locId} />}
      {tab === 'cust_bal' && <CustBalReport locId={locId} />}
      {tab === 'open' && <OpenItemsReport locId={locId} />}
      {tab === 'exp_vend' && <ExpenseByVendorReport sd={sd} ed={ed} locId={locId} />}
      {tab === 'inc_cust' && <IncomeByCustomerReport sd={sd} ed={ed} locId={locId} />}
      {tab === 'sales_cust' && <SalesByCustomerReport sd={sd} ed={ed} locId={locId} />}
      {tab === 'txn_list' && <TransactionListReport sd={sd} ed={ed} locId={locId} />}

      {drill && <GlDrillDown accountId={drill.accountId} accountNumber={drill.accountNumber} accountName={drill.accountName} startDate={sd} endDate={ed} locationId={locId} onClose={() => setDrill(null)} />}
    </div>
  );
}

// ===== Helpers =====
function Ld() { return <div className="card p-12 flex items-center justify-center"><Loader2 size={24} className="animate-spin text-slate-500" /></div>; }
function Er({ m }: { m: string }) { return <div className="card p-8 text-center"><AlertCircle size={24} className="mx-auto text-red-400 mb-2" /><p className="text-sm text-red-400">{m}</p></div>; }
function Em({ m }: { m?: string }) { return <div className="card p-8 text-center text-sm text-slate-500">{m ?? 'No data.'}</div>; }
function Cr({ children, onClick, cls }: { children: React.ReactNode; onClick?: () => void; cls?: string }) {
  return <tr onClick={onClick} className={clsx('transition-colors', onClick ? 'cursor-pointer hover:bg-slate-800/40' : 'hover:bg-slate-800/20', cls)}>{children}</tr>;
}

// ===== P&L with % Rev + Comparative =====
interface ISAcct { accountId: string; accountNumber: string; accountName: string; amountCents: number }
interface ISGroup { name: string; accounts: ISAcct[]; totalCents: number }
interface ISSection { type: string; label: string; groups: ISGroup[]; totalCents: number }
interface ISR { sections: ISSection[]; summary: { revenueCents: number; cogsCents: number; grossProfitCents: number; opexCents: number; ebitdaCents: number; otherCents: number; netIncomeCents: number; grossMarginPct: number; netMarginPct: number } }

function PnlReport({ sd, ed, locId, onDrill, compare }: { sd: string; ed: string; locId: string; onDrill: (t: DrillDownTarget) => void; compare: boolean }) {
  const p: Record<string, string> = { start_date: sd, end_date: ed };
  if (locId !== 'all') p.location_id = locId;
  const { data, isLoading, error } = useQuery<ISR>('/api/reports/income-statement', p);

  // Prior period (month before)
  const priorEnd = new Date(sd);
  priorEnd.setDate(priorEnd.getDate() - 1);
  const priorStart = `${priorEnd.getFullYear()}-${String(priorEnd.getMonth()+1).padStart(2,'0')}-01`;
  const pp: Record<string, string> = { start_date: priorStart, end_date: priorEnd.toISOString().slice(0,10) };
  if (locId !== 'all') pp.location_id = locId;
  const { data: priorData } = useQuery<ISR>(compare ? '/api/reports/income-statement' : null, compare ? pp : undefined);

  if (isLoading) return <Ld />;
  if (error) return <Er m={String(error)} />;
  if (!data) return <Em />;

  const { sections, summary: s } = data;
  const ps = priorData?.summary;
  const rb = Math.abs(s.revenueCents) || 1;

  // Build prior account lookup
  const priorAcctMap = new Map<string, number>();
  if (priorData) {
    for (const sec of priorData.sections) {
      for (const g of sec.groups) {
        for (const a of g.accounts) priorAcctMap.set(a.accountNumber, a.amountCents);
      }
    }
  }

  return (
    <div className="card overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-800">
        <h2 className="text-base font-semibold text-white">Income Statement</h2>
        <p className="text-2xs text-slate-500 mt-0.5 font-mono">{sd} through {ed}{compare ? ` vs ${priorStart} through ${priorEnd.toISOString().slice(0,10)}` : ''}</p>
      </div>
      <table className="w-full">
        <thead>
          <tr className="border-b border-slate-800/50">
            <th className="px-6 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500 w-24">Account</th>
            <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Description</th>
            <th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500">Current</th>
            <th className="px-3 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500 w-14">% Rev</th>
            {compare && <th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500">Prior</th>}
            {compare && <th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500">Variance</th>}
          </tr>
        </thead>
        <tbody>
          {sections.map((sec) => (
            <PnlSec key={sec.type} sec={sec} rb={rb} onDrill={onDrill} compare={compare} priorMap={priorAcctMap} />
          ))}
          <SmryLine l="Gross Profit" a={s.grossProfitCents} pct={s.grossMarginPct} rb={rb} bold compare={compare} prior={ps?.grossProfitCents} />
          <SmryLine l="EBITDA" a={s.ebitdaCents} rb={rb} compare={compare} prior={ps?.ebitdaCents} />
          <SmryLine l="Net Income" a={s.netIncomeCents} pct={s.netMarginPct} rb={rb} bold hl compare={compare} prior={ps?.netIncomeCents} />
        </tbody>
      </table>
    </div>
  );
}

function PnlSec({ sec, rb, onDrill, compare, priorMap }: { sec: ISSection; rb: number; onDrill: (t: DrillDownTarget) => void; compare: boolean; priorMap: Map<string, number> }) {
  return (
    <>
      <tr className="bg-slate-800/30">
        <td colSpan={compare ? 6 : 4} className="px-6 py-2 text-xs font-semibold text-slate-300 uppercase tracking-wider">{sec.label}
          <span className="ml-2 font-mono text-slate-500">{formatMoney(sec.totalCents)}</span>
        </td>
      </tr>
      {sec.groups.flatMap((g) => g.accounts.map((a) => {
        const prior = priorMap.get(a.accountNumber) ?? 0;
        const variance = a.amountCents - prior;
        return (
          <Cr key={a.accountNumber} onClick={() => onDrill({ accountId: a.accountId, accountNumber: a.accountNumber, accountName: a.accountName })}>
            <td className="px-6 py-1.5 text-xs font-mono text-slate-500 pl-10">{a.accountNumber}</td>
            <td className="px-4 py-1.5 text-sm text-slate-300 flex items-center gap-1">{a.accountName}<ChevronRight size={10} className="text-slate-600" /></td>
            <td className="px-4 py-1.5 text-right text-sm font-mono tabular-nums text-slate-200">{formatMoney(a.amountCents)}</td>
            <td className="px-3 py-1.5 text-right text-2xs font-mono text-slate-600">{Math.round(Math.abs(a.amountCents)/rb*100)}%</td>
            {compare && <td className="px-4 py-1.5 text-right text-sm font-mono text-slate-400">{formatMoney(prior)}</td>}
            {compare && <td className={clsx('px-4 py-1.5 text-right text-sm font-mono', variance > 0 ? 'text-emerald-400' : variance < 0 ? 'text-red-400' : 'text-slate-500')}>{variance > 0 ? '+' : ''}{formatMoney(variance)}</td>}
          </Cr>
        );
      }))}
    </>
  );
}

function SmryLine({ l, a, pct, rb, bold, hl, compare, prior }: { l: string; a: number; pct?: number; rb: number; bold?: boolean; hl?: boolean; compare?: boolean; prior?: number }) {
  const v = prior !== undefined ? a - prior : 0;
  return (
    <tr className={clsx(hl ? 'bg-brand-500/[0.04]' : 'bg-slate-800/20')}>
      <td></td>
      <td className={clsx('px-4 py-2.5', bold ? 'text-sm font-semibold text-white' : 'text-sm text-slate-300')}>{l}</td>
      <td className="px-4 py-2.5 text-right">
        <span className={clsx('font-mono tabular-nums', bold ? 'text-base font-semibold' : 'text-sm', hl ? (a >= 0 ? 'text-emerald-400' : 'text-red-400') : 'text-white')}>{formatMoney(a)}</span>
        {pct !== undefined && <span className="ml-2 text-2xs text-slate-500 font-mono">{pct}%</span>}
      </td>
      <td className="px-3 py-2.5 text-right text-2xs font-mono text-slate-600">{Math.round(Math.abs(a)/rb*100)}%</td>
      {compare && <td className="px-4 py-2.5 text-right font-mono text-sm text-slate-400">{prior !== undefined ? formatMoney(prior) : ''}</td>}
      {compare && <td className={clsx('px-4 py-2.5 text-right font-mono text-sm', v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-slate-500')}>{prior !== undefined ? `${v > 0 ? '+' : ''}${formatMoney(v)}` : ''}</td>}
    </tr>
  );
}

// ===== Balance Sheet =====
function BsReport({ ed, locId, onDrill }: { ed: string; locId: string; onDrill: (t: DrillDownTarget) => void }) {
  const p: Record<string, string> = { as_of_date: ed };
  if (locId !== 'all') p.location_id = locId;
  const { data, isLoading, error } = useQuery<{ sections: { type: string; label: string; subTypes: { name: string; groups: { name: string; accounts: { accountId: string; accountNumber: string; accountName: string; balanceCents: number }[]; totalCents: number }[]; totalCents: number }[]; totalCents: number }[]; summary: { totalAssetsCents: number; totalLiabilitiesCents: number; totalEquityCents: number; isBalanced: boolean; varianceCents: number } }>('/api/reports/balance-sheet', p);
  if (isLoading) return <Ld />;
  if (error) return <Er m={String(error)} />;
  if (!data) return <Em />;
  const { sections, summary: s } = data;
  return (
    <div className="card overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
        <div><h2 className="text-base font-semibold text-white">Balance Sheet</h2><p className="text-2xs text-slate-500 mt-0.5 font-mono">As of {ed}</p></div>
        {s.isBalanced ? <span className="px-2.5 py-1 rounded-md text-xs font-medium bg-emerald-500/10 text-emerald-400">Balanced ✓</span> : <span className="px-2.5 py-1 rounded-md text-xs font-medium bg-red-500/10 text-red-400 flex items-center gap-1"><AlertCircle size={12}/>Off by {formatMoney(Math.abs(s.varianceCents))}</span>}
      </div>
      <table className="w-full">
        <thead><tr className="border-b border-slate-800/50"><th className="px-6 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500 w-24">Account</th><th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Description</th><th className="px-6 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500">Balance</th></tr></thead>
        <tbody>
          {sections.map((sec) => (
            <>{/* section header */}
              <tr key={sec.type} className="bg-slate-800/30"><td colSpan={2} className="px-6 py-2 text-xs font-semibold text-slate-300 uppercase">{sec.label}</td><td className="px-6 py-2 text-right text-xs font-mono font-semibold text-slate-300">{formatMoney(sec.totalCents)}</td></tr>
              {sec.subTypes.flatMap((st) => st.groups.flatMap((g) => g.accounts.map((a) => (
                <Cr key={a.accountNumber} onClick={() => onDrill({ accountId: a.accountId, accountNumber: a.accountNumber, accountName: a.accountName })}>
                  <td className="px-6 py-1.5 text-xs font-mono text-slate-500 pl-10">{a.accountNumber}</td>
                  <td className="px-4 py-1.5 text-sm text-slate-400 flex items-center gap-1">{a.accountName}<ChevronRight size={10} className="text-slate-600"/></td>
                  <td className="px-6 py-1.5 text-right text-sm font-mono tabular-nums text-slate-300">{formatMoney(a.balanceCents)}</td>
                </Cr>
              ))))}
            </>
          ))}
          <tr className="bg-slate-800/30"><td/><td className="px-4 py-2.5 text-sm font-semibold text-white">Total Assets</td><td className="px-6 py-2.5 text-right text-base font-mono font-semibold text-white">{formatMoney(s.totalAssetsCents)}</td></tr>
          <tr className="bg-brand-500/[0.04]"><td/><td className="px-4 py-2.5 text-sm font-semibold text-white">Total L + E</td><td className="px-6 py-2.5 text-right text-base font-mono font-semibold text-white">{formatMoney(s.totalLiabilitiesCents + s.totalEquityCents)}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

// ===== Trial Balance =====
function TbReport({ locId, onDrill }: { locId: string; onDrill: (t: DrillDownTarget) => void }) {
  const p: Record<string, string> = {};
  if (locId !== 'all') p.location_id = locId;
  const { data, isLoading, error } = useQuery<{ data: { account_number: string; account_name: string; account_type: string; total_debits: number; total_credits: number; net_balance: number }[] }>('/api/gl/trial-balance', p);
  if (isLoading) return <Ld />;
  if (error) return <Er m={String(error)} />;
  const rows = data?.data ?? [];
  if (!rows.length) return <Em m="No posted entries." />;
  const td = rows.reduce((s, r) => s + Number(r.total_debits), 0);
  const tc = rows.reduce((s, r) => s + Number(r.total_credits), 0);
  return (
    <div className="card overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between"><div><h2 className="text-base font-semibold text-white">Trial Balance</h2><p className="text-2xs text-slate-500">{rows.length} accounts</p></div>{td===tc ? <span className="px-2.5 py-1 rounded-md text-xs font-medium bg-emerald-500/10 text-emerald-400">Balanced ✓</span> : <span className="px-2.5 py-1 rounded-md text-xs font-medium bg-red-500/10 text-red-400">Unbalanced</span>}</div>
      <table className="w-full text-sm"><thead><tr className="border-b border-slate-800/50 text-2xs text-slate-500 uppercase"><th className="px-6 py-2.5 text-left w-24">Account</th><th className="px-4 py-2.5 text-left">Name</th><th className="px-4 py-2.5 text-left">Type</th><th className="px-6 py-2.5 text-right">Debits</th><th className="px-6 py-2.5 text-right">Credits</th><th className="px-6 py-2.5 text-right">Net</th></tr></thead>
        <tbody className="divide-y divide-slate-800/30">{rows.map((r) => (<Cr key={r.account_number} onClick={() => onDrill({ accountNumber: r.account_number, accountName: r.account_name })}><td className="px-6 py-1.5 text-xs font-mono text-slate-500">{r.account_number}</td><td className="px-4 py-1.5 text-slate-300 flex items-center gap-1">{r.account_name}<ChevronRight size={10} className="text-slate-600"/></td><td className="px-4 py-1.5 text-2xs text-slate-500">{r.account_type}</td><td className="px-6 py-1.5 text-right font-mono text-slate-300">{Number(r.total_debits) > 0 ? formatMoney(r.total_debits) : ''}</td><td className="px-6 py-1.5 text-right font-mono text-slate-300">{Number(r.total_credits) > 0 ? formatMoney(r.total_credits) : ''}</td><td className="px-6 py-1.5 text-right font-mono font-medium text-slate-200">{formatMoney(r.net_balance)}</td></Cr>))}</tbody>
        <tfoot><tr className="border-t-2 border-slate-700 bg-slate-800/30"><td colSpan={3} className="px-6 py-2.5 font-semibold text-white">Totals</td><td className="px-6 py-2.5 text-right font-mono font-semibold text-white">{formatMoney(td)}</td><td className="px-6 py-2.5 text-right font-mono font-semibold text-white">{formatMoney(tc)}</td><td className="px-6 py-2.5 text-right font-mono font-semibold text-white">{formatMoney(td-tc)}</td></tr></tfoot>
      </table>
    </div>
  );
}

// ===== GL Detail =====
function GlReport({ sd, ed, locId }: { sd: string; ed: string; locId: string }) {
  const p: Record<string, string> = { start_date: sd, end_date: ed };
  if (locId !== 'all') p.location_id = locId;
  const { data, isLoading, error } = useQuery<{ data: { id: string; entryNumber: string; entryDate: string; sourceModule: string; entryMemo: string|null; accountNumber: string; accountName: string; debitCents: number; creditCents: number }[]; summary: { totalDebitCents: number; totalCreditCents: number } }>('/api/reports/gl-detail', p);
  if (isLoading) return <Ld />;
  if (error) return <Er m={String(error)} />;
  const rows = data?.data ?? [];
  if (!rows.length) return <Em m="No GL entries." />;
  return (
    <div className="card overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-800"><h2 className="text-base font-semibold text-white">GL Detail</h2><p className="text-2xs text-slate-500 font-mono">{sd} – {ed} · {rows.length} entries</p></div>
      <table className="w-full text-sm"><thead><tr className="border-b border-slate-800/50 text-2xs text-slate-500 uppercase"><th className="px-4 py-2.5 text-left">Date</th><th className="px-4 py-2.5 text-left">Entry</th><th className="px-4 py-2.5 text-left">Account</th><th className="px-4 py-2.5 text-left">Memo</th><th className="px-4 py-2.5 text-left">Source</th><th className="px-4 py-2.5 text-right">Debit</th><th className="px-4 py-2.5 text-right">Credit</th></tr></thead>
        <tbody className="divide-y divide-slate-800/30">{rows.slice(0,200).map((r) => (<tr key={r.id} className="hover:bg-slate-800/20"><td className="px-4 py-1.5 font-mono text-xs text-slate-400">{r.entryDate}</td><td className="px-4 py-1.5 font-mono text-xs text-slate-300">{r.entryNumber}</td><td className="px-4 py-1.5 text-slate-300"><span className="font-mono text-xs text-slate-500 mr-1">{r.accountNumber}</span>{r.accountName}</td><td className="px-4 py-1.5 text-slate-400 max-w-[160px] truncate">{r.entryMemo??'—'}</td><td className="px-4 py-1.5 text-2xs text-slate-500">{r.sourceModule}</td><td className="px-4 py-1.5 text-right font-mono text-slate-300">{r.debitCents>0?formatMoney(r.debitCents):''}</td><td className="px-4 py-1.5 text-right font-mono text-slate-300">{r.creditCents>0?formatMoney(r.creditCents):''}</td></tr>))}</tbody>
        <tfoot><tr className="border-t-2 border-slate-700 bg-slate-800/30"><td colSpan={5} className="px-4 py-2.5 font-semibold text-white">Totals</td><td className="px-4 py-2.5 text-right font-mono font-semibold text-white">{formatMoney(data?.summary.totalDebitCents??0)}</td><td className="px-4 py-2.5 text-right font-mono font-semibold text-white">{formatMoney(data?.summary.totalCreditCents??0)}</td></tr></tfoot>
      </table>
    </div>
  );
}

// ===== Aging (shared for AP/AR) =====
function AgingBuckets({ b, t }: { b: Record<string, { count: number; totalCents: number }>; t: number }) {
  return (
    <div className="grid grid-cols-6 gap-3 mb-4">
      {['CURRENT','1-30','31-60','61-90','90+'].map((k) => { const d = b[k]??{count:0,totalCents:0}; return <div key={k} className="bg-gray-800/50 border border-gray-700/50 rounded-lg p-3"><p className="text-xs text-gray-400">{k==='CURRENT'?'Current':`${k} days`}</p><p className="text-lg font-mono font-semibold text-white mt-1">{formatMoney(d.totalCents)}</p><p className="text-2xs text-gray-500">{d.count} items</p></div>; })}
      <div className="bg-gray-800/50 border border-emerald-700/30 rounded-lg p-3"><p className="text-xs text-emerald-400">Total</p><p className="text-lg font-mono font-semibold text-emerald-400 mt-1">{formatMoney(t)}</p></div>
    </div>
  );
}

function AgingReport({ type, locId }: { type: 'ar' | 'ap'; locId: string }) {
  const p: Record<string, string> = {};
  if (locId !== 'all') p.location_id = locId;
  const qs = new URLSearchParams(p).toString();
  const { data, isLoading, error } = useQuery<AgingResponse>(`/api/reports/${type}-aging${qs?'?'+qs:''}`);
  if (isLoading) return <Ld />;
  if (error) return <Er m={String(error)} />;
  if (!data) return <Em />;
  const isAR = type === 'ar';
  return (
    <div><h2 className="text-base font-semibold text-white mb-3">{isAR?'AR':'AP'} Aging</h2><AgingBuckets b={data.buckets} t={data.totalOutstanding} />
      <div className="card overflow-hidden"><table className="w-full text-sm"><thead><tr className="border-b border-slate-800/50 text-2xs text-slate-500 uppercase"><th className="px-4 py-2.5 text-left">{isAR?'Customer':'Vendor'}</th><th className="px-4 py-2.5 text-left">{isAR?'Invoice':'Bill'} #</th><th className="px-4 py-2.5 text-left">Due</th><th className="px-4 py-2.5 text-left">Bucket</th><th className="px-4 py-2.5 text-left">Company</th><th className="px-4 py-2.5 text-right">Balance</th></tr></thead>
        <tbody className="divide-y divide-slate-800/30">{data.data.map((r,i) => (<tr key={i} className="hover:bg-slate-800/20"><td className="px-4 py-1.5 text-slate-300">{isAR?r.customerName:r.vendorName}</td><td className="px-4 py-1.5 font-mono text-xs text-slate-400">{isAR?r.invoiceNumber:r.billNumber}</td><td className="px-4 py-1.5 font-mono text-xs text-slate-400">{r.dueDate}</td><td className="px-4 py-1.5"><span className={clsx('px-1.5 py-0.5 rounded text-2xs',r.agingBucket==='CURRENT'?'bg-emerald-500/20 text-emerald-300':r.agingBucket==='90+'?'bg-red-500/20 text-red-300':'bg-amber-500/20 text-amber-300')}>{r.agingBucket}</span></td><td className="px-4 py-1.5 text-xs text-slate-500">{r.locationName}</td><td className="px-4 py-1.5 text-right font-mono text-slate-200">{formatMoney(r.balanceCents)}</td></tr>))}</tbody>
      </table></div>
    </div>
  );
}

// ===== Job Profitability =====
function JobProfReport({ locId }: { locId: string }) {
  const p: Record<string, string> = {};
  if (locId !== 'all') p.location_id = locId;
  const qs = new URLSearchParams(p).toString();
  const { data, isLoading, error } = useQuery<{ data: { jobNumber: string; jobName: string; customerName: string; status: string; contractCents: number; actualCostCents: number; billedCents: number; pctComplete: number; marginPct: number|null; isOverBudget: boolean }[] }>(`/api/reports/job-profitability${qs?'?'+qs:''}`);
  if (isLoading) return <Ld />;
  if (error) return <Er m={String(error)} />;
  const rows = data?.data ?? [];
  if (!rows.length) return <Em m="No jobs." />;
  return (
    <div className="card overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-800"><h2 className="text-base font-semibold text-white">Job Profitability</h2><p className="text-2xs text-slate-500">{rows.length} jobs</p></div>
      <table className="w-full text-sm"><thead><tr className="border-b border-slate-800/50 text-2xs text-slate-500 uppercase"><th className="px-4 py-2.5 text-left">Job</th><th className="px-4 py-2.5 text-left">Customer</th><th className="px-4 py-2.5 text-left">Status</th><th className="px-4 py-2.5 text-right">Contract</th><th className="px-4 py-2.5 text-right">Cost</th><th className="px-4 py-2.5 text-right">Billed</th><th className="px-4 py-2.5 text-right">% Done</th><th className="px-4 py-2.5 text-right">Margin</th></tr></thead>
        <tbody className="divide-y divide-slate-800/30">{rows.map((r) => (<tr key={r.jobNumber} className={clsx('hover:bg-slate-800/20',r.isOverBudget&&'bg-red-500/[0.03]')}><td className="px-4 py-1.5"><span className="font-mono text-xs text-slate-500 mr-1">{r.jobNumber}</span><span className="text-slate-300">{r.jobName}</span></td><td className="px-4 py-1.5 text-slate-400">{r.customerName??'—'}</td><td className="px-4 py-1.5"><span className={clsx('px-1.5 py-0.5 rounded text-2xs',r.status==='ACTIVE'?'bg-emerald-500/20 text-emerald-300':'bg-gray-500/20 text-gray-300')}>{r.status}</span></td><td className="px-4 py-1.5 text-right font-mono text-slate-300">{r.contractCents>0?formatMoney(r.contractCents):'—'}</td><td className="px-4 py-1.5 text-right font-mono text-slate-300">{formatMoney(r.actualCostCents)}</td><td className="px-4 py-1.5 text-right font-mono text-slate-300">{formatMoney(r.billedCents)}</td><td className="px-4 py-1.5 text-right font-mono text-slate-400">{Math.round(r.pctComplete*100)}%</td><td className={clsx('px-4 py-1.5 text-right font-mono font-medium',r.marginPct!==null?(r.marginPct>=20?'text-emerald-400':r.marginPct>=0?'text-amber-400':'text-red-400'):'text-slate-500')}>{r.marginPct!==null?`${r.marginPct}%`:'—'}</td></tr>))}</tbody>
      </table>
    </div>
  );
}

// ===== Budget vs Actual =====
function BvaReport({ sd, ed, locId }: { sd: string; ed: string; locId: string }) {
  const p: Record<string, string> = { start_date: sd, end_date: ed, fiscal_year: sd.slice(0,4) };
  if (locId !== 'all') p.location_id = locId;
  const qs = new URLSearchParams(p).toString();
  const { data, isLoading, error } = useQuery<{ data: { accountNumber: string; accountName: string; accountType: string; budgetCents: number; actualCents: number; varianceCents: number; variancePct: number; isFavorable: boolean }[]; totals: Record<string, { budget: number; actual: number; variance: number }> }>(`/api/budgets/vs-actual?${qs}`);
  if (isLoading) return <Ld />;
  if (error) return <Er m={String(error)} />;
  const rows = data?.data ?? [];
  if (!rows.length) return <Em m="No budget data. Create budgets first to see variance analysis." />;
  return (
    <div className="card overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-800"><h2 className="text-base font-semibold text-white">Budget vs Actual</h2><p className="text-2xs text-slate-500 font-mono">{sd} – {ed}</p></div>
      <table className="w-full text-sm"><thead><tr className="border-b border-slate-800/50 text-2xs text-slate-500 uppercase"><th className="px-4 py-2.5 text-left w-24">Account</th><th className="px-4 py-2.5 text-left">Name</th><th className="px-4 py-2.5 text-left">Type</th><th className="px-4 py-2.5 text-right">Budget</th><th className="px-4 py-2.5 text-right">Actual</th><th className="px-4 py-2.5 text-right">$ Var</th><th className="px-4 py-2.5 text-right">% Var</th></tr></thead>
        <tbody className="divide-y divide-slate-800/30">{rows.map((r) => (<tr key={r.accountNumber} className="hover:bg-slate-800/20"><td className="px-4 py-1.5 font-mono text-xs text-slate-500">{r.accountNumber}</td><td className="px-4 py-1.5 text-slate-300">{r.accountName}</td><td className="px-4 py-1.5 text-2xs text-slate-500">{r.accountType}</td><td className="px-4 py-1.5 text-right font-mono text-slate-400">{formatMoney(r.budgetCents)}</td><td className="px-4 py-1.5 text-right font-mono text-slate-300">{formatMoney(r.actualCents)}</td><td className={clsx('px-4 py-1.5 text-right font-mono',r.isFavorable?'text-emerald-400':'text-red-400')}>{formatMoney(r.varianceCents)}</td><td className={clsx('px-4 py-1.5 text-right font-mono text-xs',r.isFavorable?'text-emerald-400':'text-red-400')}>{r.variancePct}%</td></tr>))}</tbody>
      </table>
    </div>
  );
}

// ===== Consolidated =====
function ConsolReport({ sd, ed }: { sd: string; ed: string }) {
  const { data, isLoading, error } = useQuery<{ accounts: { accountNumber: string; accountName: string; accountType: string; consolidatedCents: number; byLocation: Record<string, number> }[]; locations: { id: string; name: string; shortCode: string }[]; eliminatedCents: number }>(`/api/reports/consolidated?start_date=${sd}&end_date=${ed}`);
  if (isLoading) return <Ld />;
  if (error) return <Er m={String(error)} />;
  const accts = data?.accounts ?? [];
  const locs = data?.locations ?? [];
  if (!accts.length) return <Em m="No consolidated data." />;
  return (
    <div className="card overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-800"><h2 className="text-base font-semibold text-white">Consolidated P&L</h2><p className="text-2xs text-slate-500 font-mono">{sd} – {ed} · IC eliminations applied · {formatMoney(data?.eliminatedCents??0)} eliminated</p></div>
      <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-slate-800/50 text-2xs text-slate-500 uppercase"><th className="px-4 py-2.5 text-left sticky left-0 bg-surface-900">Account</th>{locs.slice(0,8).map((l) => <th key={l.id} className="px-3 py-2.5 text-right min-w-[80px]">{l.shortCode}</th>)}<th className="px-4 py-2.5 text-right font-semibold">Consol</th></tr></thead>
        <tbody className="divide-y divide-slate-800/30">{accts.map((a) => (<tr key={a.accountNumber} className="hover:bg-slate-800/20"><td className="px-4 py-1.5 text-slate-300 sticky left-0 bg-surface-900"><span className="font-mono text-xs text-slate-500 mr-1">{a.accountNumber}</span>{a.accountName}</td>{locs.slice(0,8).map((l) => <td key={l.id} className="px-3 py-1.5 text-right font-mono text-xs text-slate-400">{a.byLocation[l.id]?formatMoney(a.byLocation[l.id]):''}</td>)}<td className="px-4 py-1.5 text-right font-mono font-medium text-white">{formatMoney(a.consolidatedCents)}</td></tr>))}</tbody>
      </table></div>
    </div>
  );
}

// ===== Equity Changes =====
function EquityReport({ sd, ed, locId }: { sd: string; ed: string; locId: string }) {
  const p: Record<string, string> = { start_date: sd, end_date: ed };
  if (locId !== 'all') p.location_id = locId;
  const qs = new URLSearchParams(p).toString();
  const { data, isLoading, error } = useQuery<{ accounts: { accountNumber: string; accountName: string; beginningBalanceCents: number; activityCents: number; endingBalanceCents: number }[]; netIncomeCents: number; summary: { totalBeginning: number; totalActivity: number; totalEnding: number } }>(`/api/reports/equity-changes?${qs}`);
  if (isLoading) return <Ld />;
  if (error) return <Er m={String(error)} />;
  const accts = data?.accounts ?? [];
  return (
    <div className="card overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-800"><h2 className="text-base font-semibold text-white">Statement of Changes in Equity</h2><p className="text-2xs text-slate-500 font-mono">{sd} – {ed}</p></div>
      <table className="w-full text-sm"><thead><tr className="border-b border-slate-800/50 text-2xs text-slate-500 uppercase"><th className="px-4 py-2.5 text-left">Account</th><th className="px-4 py-2.5 text-right">Beginning</th><th className="px-4 py-2.5 text-right">Activity</th><th className="px-4 py-2.5 text-right">Ending</th></tr></thead>
        <tbody className="divide-y divide-slate-800/30">
          {accts.map((a) => (<tr key={a.accountNumber} className="hover:bg-slate-800/20"><td className="px-4 py-1.5 text-slate-300"><span className="font-mono text-xs text-slate-500 mr-1">{a.accountNumber}</span>{a.accountName}</td><td className="px-4 py-1.5 text-right font-mono text-slate-400">{formatMoney(a.beginningBalanceCents)}</td><td className={clsx('px-4 py-1.5 text-right font-mono',a.activityCents>=0?'text-emerald-400':'text-red-400')}>{formatMoney(a.activityCents)}</td><td className="px-4 py-1.5 text-right font-mono font-medium text-white">{formatMoney(a.endingBalanceCents)}</td></tr>))}
          <tr className="bg-slate-800/20"><td className="px-4 py-2 text-sm text-slate-300">Net Income (retained)</td><td/><td className="px-4 py-2 text-right font-mono text-emerald-400">{formatMoney(data?.netIncomeCents??0)}</td><td/></tr>
        </tbody>
        <tfoot><tr className="border-t-2 border-slate-700 bg-slate-800/30"><td className="px-4 py-2.5 font-semibold text-white">Total Equity</td><td className="px-4 py-2.5 text-right font-mono font-semibold text-white">{formatMoney(data?.summary.totalBeginning??0)}</td><td className="px-4 py-2.5 text-right font-mono font-semibold text-white">{formatMoney(data?.summary.totalActivity??0)}</td><td className="px-4 py-2.5 text-right font-mono font-semibold text-emerald-400">{formatMoney(data?.summary.totalEnding??0)}</td></tr></tfoot>
      </table>
    </div>
  );
}

// ===== Vendor Balances =====
function VendBalReport({ locId }: { locId: string }) {
  const p: Record<string, string> = {};
  if (locId !== 'all') p.location_id = locId;
  const qs = new URLSearchParams(p).toString();
  const { data, isLoading, error } = useQuery<{ data: { vendorName: string; is1099: boolean; totalBilledCents: number; totalPaidCents: number; openBalanceCents: number; billCount: number; openBillCount: number; aging: Record<string, number> }[]; summary: { totalVendors: number; totalOpenCents: number; vendorsWithBalance: number } }>(`/api/reports/vendor-balances${qs?'?'+qs:''}`);
  if (isLoading) return <Ld />;
  if (error) return <Er m={String(error)} />;
  const rows = data?.data ?? [];
  if (!rows.length) return <Em m="No vendor data." />;
  return (
    <div className="card overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-800"><h2 className="text-base font-semibold text-white">Vendor Balance Summary</h2><p className="text-2xs text-slate-500">{data?.summary.vendorsWithBalance} vendors with open balance · {formatMoney(data?.summary.totalOpenCents??0)} outstanding</p></div>
      <table className="w-full text-sm"><thead><tr className="border-b border-slate-800/50 text-2xs text-slate-500 uppercase"><th className="px-4 py-2.5 text-left">Vendor</th><th className="px-4 py-2.5 text-right">Billed</th><th className="px-4 py-2.5 text-right">Paid</th><th className="px-4 py-2.5 text-right">Open</th><th className="px-4 py-2.5 text-right">Bills</th></tr></thead>
        <tbody className="divide-y divide-slate-800/30">{rows.map((r) => (<tr key={r.vendorName} className="hover:bg-slate-800/20"><td className="px-4 py-1.5 text-slate-300">{r.vendorName}{r.is1099 && <span className="ml-1 px-1 py-0.5 text-2xs bg-amber-500/20 text-amber-300 rounded">1099</span>}</td><td className="px-4 py-1.5 text-right font-mono text-slate-400">{formatMoney(r.totalBilledCents)}</td><td className="px-4 py-1.5 text-right font-mono text-slate-400">{formatMoney(r.totalPaidCents)}</td><td className="px-4 py-1.5 text-right font-mono text-white font-medium">{formatMoney(r.openBalanceCents)}</td><td className="px-4 py-1.5 text-right text-slate-500">{r.openBillCount}/{r.billCount}</td></tr>))}</tbody>
      </table>
    </div>
  );
}

// ===== Customer Balances =====
function CustBalReport({ locId }: { locId: string }) {
  const p: Record<string, string> = {};
  if (locId !== 'all') p.location_id = locId;
  const qs = new URLSearchParams(p).toString();
  const { data, isLoading, error } = useQuery<{ data: { customerName: string; email: string|null; termsDays: number; totalInvoicedCents: number; totalPaidCents: number; openBalanceCents: number; invoiceCount: number; openInvoiceCount: number }[]; summary: { totalCustomers: number; totalOpenCents: number } }>(`/api/reports/customer-balances${qs?'?'+qs:''}`);
  if (isLoading) return <Ld />;
  if (error) return <Er m={String(error)} />;
  const rows = data?.data ?? [];
  if (!rows.length) return <Em m="No customer data." />;
  return (
    <div className="card overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-800"><h2 className="text-base font-semibold text-white">Customer Balance Summary</h2><p className="text-2xs text-slate-500">{formatMoney(data?.summary.totalOpenCents??0)} outstanding</p></div>
      <table className="w-full text-sm"><thead><tr className="border-b border-slate-800/50 text-2xs text-slate-500 uppercase"><th className="px-4 py-2.5 text-left">Customer</th><th className="px-4 py-2.5 text-right">Terms</th><th className="px-4 py-2.5 text-right">Invoiced</th><th className="px-4 py-2.5 text-right">Paid</th><th className="px-4 py-2.5 text-right">Open</th><th className="px-4 py-2.5 text-right">Invoices</th></tr></thead>
        <tbody className="divide-y divide-slate-800/30">{rows.map((r) => (<tr key={r.customerName} className="hover:bg-slate-800/20"><td className="px-4 py-1.5 text-slate-300">{r.customerName}</td><td className="px-4 py-1.5 text-right text-xs text-slate-500">Net {r.termsDays}</td><td className="px-4 py-1.5 text-right font-mono text-slate-400">{formatMoney(r.totalInvoicedCents)}</td><td className="px-4 py-1.5 text-right font-mono text-slate-400">{formatMoney(r.totalPaidCents)}</td><td className="px-4 py-1.5 text-right font-mono text-white font-medium">{formatMoney(r.openBalanceCents)}</td><td className="px-4 py-1.5 text-right text-slate-500">{r.openInvoiceCount}/{r.invoiceCount}</td></tr>))}</tbody>
      </table>
    </div>
  );
}

// ===== Open Items =====
function OpenItemsReport({ locId }: { locId: string }) {
  const p: Record<string, string> = {};
  if (locId !== 'all') p.location_id = locId;
  const qs = new URLSearchParams(p).toString();
  const { data, isLoading, error } = useQuery<{ data: { type: string; number: string; counterpartyName: string; dueDate: string; balanceCents: number; daysOverdue: number; locationName: string }[]; summary: { openInvoices: number; openBills: number; totalARCents: number; totalAPCents: number; netCents: number } }>(`/api/reports/open-items${qs?'?'+qs:''}`);
  if (isLoading) return <Ld />;
  if (error) return <Er m={String(error)} />;
  const rows = data?.data ?? [];
  const s = data?.summary;
  if (!rows.length) return <Em m="No open items." />;
  return (
    <div>
      <div className="grid grid-cols-3 gap-4 mb-4">
        <div className="bg-gray-800/50 border border-blue-700/30 rounded-lg p-3"><p className="text-xs text-blue-400">Open AR</p><p className="text-lg font-mono font-semibold text-white mt-1">{formatMoney(s?.totalARCents??0)}</p><p className="text-2xs text-gray-500">{s?.openInvoices} invoices</p></div>
        <div className="bg-gray-800/50 border border-amber-700/30 rounded-lg p-3"><p className="text-xs text-amber-400">Open AP</p><p className="text-lg font-mono font-semibold text-white mt-1">{formatMoney(s?.totalAPCents??0)}</p><p className="text-2xs text-gray-500">{s?.openBills} bills</p></div>
        <div className="bg-gray-800/50 border border-emerald-700/30 rounded-lg p-3"><p className="text-xs text-emerald-400">Net (AR − AP)</p><p className={clsx('text-lg font-mono font-semibold mt-1',(s?.netCents??0)>=0?'text-emerald-400':'text-red-400')}>{formatMoney(s?.netCents??0)}</p></div>
      </div>
      <div className="card overflow-hidden"><table className="w-full text-sm"><thead><tr className="border-b border-slate-800/50 text-2xs text-slate-500 uppercase"><th className="px-4 py-2.5 text-left">Type</th><th className="px-4 py-2.5 text-left">#</th><th className="px-4 py-2.5 text-left">Name</th><th className="px-4 py-2.5 text-left">Due</th><th className="px-4 py-2.5 text-left">Company</th><th className="px-4 py-2.5 text-right">Balance</th></tr></thead>
        <tbody className="divide-y divide-slate-800/30">{rows.map((r,i) => (<tr key={i} className="hover:bg-slate-800/20"><td className="px-4 py-1.5"><span className={clsx('px-1.5 py-0.5 rounded text-2xs',r.type==='invoice'?'bg-blue-500/20 text-blue-300':'bg-amber-500/20 text-amber-300')}>{r.type==='invoice'?'AR':'AP'}</span></td><td className="px-4 py-1.5 font-mono text-xs text-slate-400">{r.number}</td><td className="px-4 py-1.5 text-slate-300">{r.counterpartyName}</td><td className="px-4 py-1.5 font-mono text-xs text-slate-400">{r.dueDate}{r.daysOverdue>0&&<span className="ml-1 text-red-400">{r.daysOverdue}d</span>}</td><td className="px-4 py-1.5 text-xs text-slate-500">{r.locationName}</td><td className="px-4 py-1.5 text-right font-mono text-white">{formatMoney(r.balanceCents)}</td></tr>))}</tbody>
      </table></div>
    </div>
  );
}

// ===== Expense by Vendor =====
function ExpenseByVendorReport({ sd, ed, locId }: { sd: string; ed: string; locId: string }) {
  const [mode, setMode] = useState<'summary'|'detail'>('summary');
  const p: Record<string, string> = { start_date: sd, end_date: ed, mode };
  if (locId !== 'all') p.location_id = locId;
  const qs = new URLSearchParams(p).toString();
  const { data, isLoading, error } = useQuery<{ data: { vendorName: string; is1099: boolean; totalCents: number; transactionCount: number; accounts: { accountName: string }[]; transactions: { date: string; description: string; amountCents: number; locationCode: string }[] }[]; summary: { totalExpenseCents: number; vendorCount: number } }>(`/api/reports/expense-by-vendor?${qs}`);
  if (isLoading) return <Ld />;
  if (error) return <Er m={String(error)} />;
  const rows = data?.data ?? [];
  if (!rows.length) return <Em m="No expense data for this period." />;
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div><h2 className="text-base font-semibold text-white">Expense by Vendor</h2><p className="text-2xs text-slate-500 font-mono">{sd} – {ed} · {formatMoney(data?.summary.totalExpenseCents??0)} total</p></div>
        <div className="flex gap-1 p-0.5 rounded-lg bg-slate-800 border border-slate-700">
          <button onClick={() => setMode('summary')} className={clsx('px-3 py-1 rounded text-xs', mode==='summary'?'bg-slate-700 text-white':'text-slate-400')}>Summary</button>
          <button onClick={() => setMode('detail')} className={clsx('px-3 py-1 rounded text-xs', mode==='detail'?'bg-slate-700 text-white':'text-slate-400')}>Detail</button>
        </div>
      </div>
      <div className="card overflow-hidden"><table className="w-full text-sm"><thead><tr className="border-b border-slate-800/50 text-2xs text-slate-500 uppercase"><th className="px-4 py-2.5 text-left">Vendor</th><th className="px-4 py-2.5 text-left">{mode==='summary'?'Top Account':'Date'}</th><th className="px-4 py-2.5 text-right">Txns</th><th className="px-4 py-2.5 text-right">Total</th></tr></thead>
        <tbody className="divide-y divide-slate-800/30">{rows.map((r,ri) => (<React.Fragment key={ri}>
          <tr className="hover:bg-slate-800/20"><td className="px-4 py-1.5 text-slate-300">{r.vendorName}{r.is1099&&<span className="ml-1 px-1 py-0.5 text-2xs bg-amber-500/20 text-amber-300 rounded">1099</span>}</td><td className="px-4 py-1.5 text-xs text-slate-500">{mode==='summary'?(r.accounts[0]?.accountName??'—'):''}</td><td className="px-4 py-1.5 text-right text-slate-400">{r.transactionCount}</td><td className="px-4 py-1.5 text-right font-mono text-white font-medium">{formatMoney(r.totalCents)}</td></tr>
          {mode==='detail'&&r.transactions.map((t,i) => (<tr key={i} className="bg-slate-800/10"><td className="px-4 py-1 pl-8 text-xs text-slate-500 font-mono">{t.date}</td><td className="px-4 py-1 text-xs text-slate-400">{t.description}</td><td className="px-4 py-1 text-right text-xs text-slate-500">{t.locationCode}</td><td className="px-4 py-1 text-right font-mono text-xs text-slate-300">{formatMoney(t.amountCents)}</td></tr>))}
        </React.Fragment>))}</tbody>
      </table></div>
    </div>
  );
}

// ===== Income by Customer =====
function IncomeByCustomerReport({ sd, ed, locId }: { sd: string; ed: string; locId: string }) {
  const [mode, setMode] = useState<'summary'|'detail'>('summary');
  const p: Record<string, string> = { start_date: sd, end_date: ed, mode };
  if (locId !== 'all') p.location_id = locId;
  const qs = new URLSearchParams(p).toString();
  const { data, isLoading, error } = useQuery<{ data: { customerName: string; totalRevenueCents: number; totalPaidCents: number; totalBalanceCents: number; invoiceCount: number; invoices: { invoiceNumber: string; date: string; totalCents: number; paidCents: number; balanceCents: number; status: string; jobNumber: string|null }[] }[]; summary: { totalRevenueCents: number; totalCollectedCents: number; customerCount: number } }>(`/api/reports/income-by-customer?${qs}`);
  if (isLoading) return <Ld />;
  if (error) return <Er m={String(error)} />;
  const rows = data?.data ?? [];
  if (!rows.length) return <Em m="No income data for this period." />;
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div><h2 className="text-base font-semibold text-white">Income by Customer</h2><p className="text-2xs text-slate-500">{data?.summary.customerCount} customers · {formatMoney(data?.summary.totalRevenueCents??0)} revenue</p></div>
        <div className="flex gap-1 p-0.5 rounded-lg bg-slate-800 border border-slate-700">
          <button onClick={() => setMode('summary')} className={clsx('px-3 py-1 rounded text-xs', mode==='summary'?'bg-slate-700 text-white':'text-slate-400')}>Summary</button>
          <button onClick={() => setMode('detail')} className={clsx('px-3 py-1 rounded text-xs', mode==='detail'?'bg-slate-700 text-white':'text-slate-400')}>Detail</button>
        </div>
      </div>
      <div className="card overflow-hidden"><table className="w-full text-sm"><thead><tr className="border-b border-slate-800/50 text-2xs text-slate-500 uppercase"><th className="px-4 py-2.5 text-left">Customer</th><th className="px-4 py-2.5 text-right">Revenue</th><th className="px-4 py-2.5 text-right">Collected</th><th className="px-4 py-2.5 text-right">Outstanding</th><th className="px-4 py-2.5 text-right">Invoices</th></tr></thead>
        <tbody className="divide-y divide-slate-800/30">{rows.map((r,ri) => (<React.Fragment key={ri}>
          <tr className="hover:bg-slate-800/20"><td className="px-4 py-1.5 text-slate-300">{r.customerName}</td><td className="px-4 py-1.5 text-right font-mono text-white">{formatMoney(r.totalRevenueCents)}</td><td className="px-4 py-1.5 text-right font-mono text-emerald-400">{formatMoney(r.totalPaidCents)}</td><td className="px-4 py-1.5 text-right font-mono text-amber-400">{formatMoney(r.totalBalanceCents)}</td><td className="px-4 py-1.5 text-right text-slate-400">{r.invoiceCount}</td></tr>
          {mode==='detail'&&r.invoices.map((inv,i) => (<tr key={i} className="bg-slate-800/10"><td className="px-4 py-1 pl-8 text-xs text-slate-400"><span className="font-mono text-slate-500 mr-1">{inv.invoiceNumber}</span>{inv.date}{inv.jobNumber&&<span className="ml-1 text-indigo-400">Job {inv.jobNumber}</span>}</td><td className="px-4 py-1 text-right font-mono text-xs text-slate-300">{formatMoney(inv.totalCents)}</td><td className="px-4 py-1 text-right font-mono text-xs text-slate-400">{formatMoney(inv.paidCents)}</td><td className="px-4 py-1 text-right font-mono text-xs text-slate-400">{formatMoney(inv.balanceCents)}</td><td className="px-4 py-1 text-right"><span className={clsx('px-1 py-0.5 rounded text-2xs',inv.status==='PAID'?'bg-emerald-500/20 text-emerald-300':'bg-amber-500/20 text-amber-300')}>{inv.status}</span></td></tr>))}
        </React.Fragment>))}</tbody>
      </table></div>
    </div>
  );
}

// ===== Sales by Customer =====
function SalesByCustomerReport({ sd, ed, locId }: { sd: string; ed: string; locId: string }) {
  const [mode, setMode] = useState<'summary'|'detail'>('summary');
  const p: Record<string, string> = { start_date: sd, end_date: ed, mode };
  if (locId !== 'all') p.location_id = locId;
  const qs = new URLSearchParams(p).toString();
  const { data, isLoading, error } = useQuery<{ data: { customerName: string; totalSalesCents: number; lineCount: number; byAccount: { accountName: string; totalCents: number }[]; details: { invoiceNumber: string; description: string; qty: number; unitPriceCents: number; amountCents: number; accountName: string }[] }[]; summary: { totalSalesCents: number; customerCount: number } }>(`/api/reports/sales-by-customer?${qs}`);
  if (isLoading) return <Ld />;
  if (error) return <Er m={String(error)} />;
  const rows = data?.data ?? [];
  if (!rows.length) return <Em m="No sales data for this period." />;
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div><h2 className="text-base font-semibold text-white">Sales by Customer</h2><p className="text-2xs text-slate-500">{formatMoney(data?.summary.totalSalesCents??0)} total sales</p></div>
        <div className="flex gap-1 p-0.5 rounded-lg bg-slate-800 border border-slate-700">
          <button onClick={() => setMode('summary')} className={clsx('px-3 py-1 rounded text-xs', mode==='summary'?'bg-slate-700 text-white':'text-slate-400')}>Summary</button>
          <button onClick={() => setMode('detail')} className={clsx('px-3 py-1 rounded text-xs', mode==='detail'?'bg-slate-700 text-white':'text-slate-400')}>Detail</button>
        </div>
      </div>
      <div className="card overflow-hidden"><table className="w-full text-sm"><thead><tr className="border-b border-slate-800/50 text-2xs text-slate-500 uppercase"><th className="px-4 py-2.5 text-left">Customer</th><th className="px-4 py-2.5 text-left">{mode==='summary'?'Revenue Lines':'Item'}</th><th className="px-4 py-2.5 text-right">Items</th><th className="px-4 py-2.5 text-right">Total</th></tr></thead>
        <tbody className="divide-y divide-slate-800/30">{rows.map((r,ri) => (<React.Fragment key={ri}>
          <tr className="hover:bg-slate-800/20"><td className="px-4 py-1.5 text-slate-300">{r.customerName}</td><td className="px-4 py-1.5 text-xs text-slate-400">{mode==='summary'?r.byAccount.map((a) => a.accountName).join(', '):''}</td><td className="px-4 py-1.5 text-right text-slate-400">{r.lineCount}</td><td className="px-4 py-1.5 text-right font-mono text-white font-medium">{formatMoney(r.totalSalesCents)}</td></tr>
          {mode==='detail'&&r.details.map((d,i) => (<tr key={i} className="bg-slate-800/10"><td className="px-4 py-1 pl-8 text-xs text-slate-500 font-mono">{d.invoiceNumber}</td><td className="px-4 py-1 text-xs text-slate-400">{d.description} <span className="text-slate-600">({d.accountName})</span></td><td className="px-4 py-1 text-right font-mono text-xs text-slate-500">{d.qty} × {formatMoney(d.unitPriceCents)}</td><td className="px-4 py-1 text-right font-mono text-xs text-slate-300">{formatMoney(d.amountCents)}</td></tr>))}
        </React.Fragment>))}</tbody>
      </table></div>
    </div>
  );
}

// ===== Transaction List =====
function TransactionListReport({ sd, ed, locId }: { sd: string; ed: string; locId: string }) {
  const [mode, setMode] = useState<'detail'|'summary'>('detail');
  const p: Record<string, string> = { start_date: sd, end_date: ed, mode };
  if (locId !== 'all') p.location_id = locId;
  const qs = new URLSearchParams(p).toString();
  const { data, isLoading, error } = useQuery<{ data: any[]; summary: { totalDebits: number; totalCredits: number; entryCount: number } }>(`/api/reports/transaction-list?${qs}`);
  if (isLoading) return <Ld />;
  if (error) return <Er m={String(error)} />;
  const rows = data?.data ?? [];
  if (!rows.length) return <Em m="No transactions for this period." />;
  const s = data?.summary;
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div><h2 className="text-base font-semibold text-white">Transaction List</h2><p className="text-2xs text-slate-500 font-mono">{sd} – {ed} · {s?.entryCount} entries</p></div>
        <div className="flex gap-1 p-0.5 rounded-lg bg-slate-800 border border-slate-700">
          <button onClick={() => setMode('summary')} className={clsx('px-3 py-1 rounded text-xs', mode==='summary'?'bg-slate-700 text-white':'text-slate-400')}>By Day</button>
          <button onClick={() => setMode('detail')} className={clsx('px-3 py-1 rounded text-xs', mode==='detail'?'bg-slate-700 text-white':'text-slate-400')}>All Lines</button>
        </div>
      </div>
      <div className="card overflow-hidden">
        {mode === 'summary' ? (
          <table className="w-full text-sm"><thead><tr className="border-b border-slate-800/50 text-2xs text-slate-500 uppercase"><th className="px-4 py-2.5 text-left">Date</th><th className="px-4 py-2.5 text-right">Entries</th><th className="px-4 py-2.5 text-right">Debits</th><th className="px-4 py-2.5 text-right">Credits</th></tr></thead>
            <tbody className="divide-y divide-slate-800/30">{rows.map((r: any,i: number) => (<tr key={i} className="hover:bg-slate-800/20"><td className="px-4 py-1.5 font-mono text-slate-300">{r.date}</td><td className="px-4 py-1.5 text-right text-slate-400">{r.entryCount}</td><td className="px-4 py-1.5 text-right font-mono text-slate-300">{formatMoney(r.debitCents)}</td><td className="px-4 py-1.5 text-right font-mono text-slate-300">{formatMoney(r.creditCents)}</td></tr>))}</tbody>
          </table>
        ) : (
          <table className="w-full text-sm"><thead><tr className="border-b border-slate-800/50 text-2xs text-slate-500 uppercase"><th className="px-4 py-2.5 text-left">Date</th><th className="px-4 py-2.5 text-left">Entry</th><th className="px-4 py-2.5 text-left">Account</th><th className="px-4 py-2.5 text-left">Memo</th><th className="px-4 py-2.5 text-right">Debit</th><th className="px-4 py-2.5 text-right">Credit</th></tr></thead>
            <tbody className="divide-y divide-slate-800/30">{rows.slice(0,300).map((r: any,i: number) => (<tr key={i} className="hover:bg-slate-800/20"><td className="px-4 py-1.5 font-mono text-xs text-slate-400">{r.date}</td><td className="px-4 py-1.5 font-mono text-xs text-slate-300">{r.entryNumber}</td><td className="px-4 py-1.5 text-slate-300"><span className="font-mono text-xs text-slate-500 mr-1">{r.accountNumber}</span>{r.accountName}</td><td className="px-4 py-1.5 text-xs text-slate-400 max-w-[160px] truncate">{r.entryMemo||r.lineMemo||'—'}</td><td className="px-4 py-1.5 text-right font-mono text-slate-300">{r.debitCents>0?formatMoney(r.debitCents):''}</td><td className="px-4 py-1.5 text-right font-mono text-slate-300">{r.creditCents>0?formatMoney(r.creditCents):''}</td></tr>))}</tbody>
            <tfoot><tr className="border-t-2 border-slate-700 bg-slate-800/30"><td colSpan={4} className="px-4 py-2.5 font-semibold text-white">Totals</td><td className="px-4 py-2.5 text-right font-mono font-semibold text-white">{formatMoney(s?.totalDebits??0)}</td><td className="px-4 py-2.5 text-right font-mono font-semibold text-white">{formatMoney(s?.totalCredits??0)}</td></tr></tfoot>
          </table>
        )}
      </div>
    </div>
  );
}
