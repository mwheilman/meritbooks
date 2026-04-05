'use client';

import { useState, useMemo } from 'react';
import { clsx } from 'clsx';
import { Download, Calendar, Building2, Inbox, AlertCircle, Loader2 } from 'lucide-react';
import { useQuery } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import type { Location } from '@meritbooks/shared';

// ===== Types =====

interface ISSection {
  type: string;
  label: string;
  groups: { name: string; accounts: { accountNumber: string; accountName: string; amountCents: number }[]; totalCents: number }[];
  totalCents: number;
}

interface ISResponse {
  sections: ISSection[];
  summary: {
    revenueCents: number; cogsCents: number; grossProfitCents: number;
    opexCents: number; ebitdaCents: number; otherCents: number; netIncomeCents: number;
    grossMarginPct: number; netMarginPct: number;
  };
}

interface BSSubType { name: string; groups: { name: string; accounts: { accountNumber: string; accountName: string; balanceCents: number }[]; totalCents: number }[]; totalCents: number }
interface BSSection { type: string; label: string; subTypes: BSSubType[]; totalCents: number }
interface BSResponse {
  sections: BSSection[];
  summary: { totalAssetsCents: number; totalLiabilitiesCents: number; totalEquityCents: number; isBalanced: boolean; varianceCents: number };
}

interface TBRow { account_number: string; account_name: string; account_type: string; account_group_name: string; total_debits: number; total_credits: number; net_balance: number; location_name: string }
interface TBResponse { data: TBRow[] }

// ===== Tabs =====

const REPORT_TABS = [
  { key: 'pnl', label: 'Income Statement' },
  { key: 'bs', label: 'Balance Sheet' },
  { key: 'tb', label: 'Trial Balance' },
] as const;

type ReportType = typeof REPORT_TABS[number]['key'];

function getDefaultDates() {
  const now = new Date();
  const start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
  return { start, end };
}

// ===== Main Component =====

export function ReportViewer() {
  const [activeReport, setActiveReport] = useState<ReportType>('pnl');
  const defaults = useMemo(() => getDefaultDates(), []);
  const [startDate, setStartDate] = useState(defaults.start);
  const [endDate, setEndDate] = useState(defaults.end);
  const [locationId, setLocationId] = useState('all');

  const { data: locations } = useQuery<Location[]>('/api/locations');

  return (
    <div>
      {/* Tabs */}
      <div className="flex items-center gap-1 p-1 rounded-lg bg-surface-900 border border-slate-800 w-fit mb-4">
        {REPORT_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveReport(tab.key)}
            className={clsx(
              'px-3 py-1.5 rounded-md text-sm transition-colors whitespace-nowrap',
              activeReport === tab.key ? 'bg-slate-800 text-white font-medium' : 'text-slate-400 hover:text-slate-300'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 mb-6">
        <div className="flex items-center gap-2">
          <Calendar size={14} className="text-slate-500" />
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
            className="input w-40 text-sm font-mono" />
          <span className="text-slate-600 text-sm">to</span>
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
            className="input w-40 text-sm font-mono" />
        </div>

        <div className="flex items-center gap-2">
          <Building2 size={14} className="text-slate-500" />
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)} className="input w-56">
            <option value="all">All Companies (Consolidated)</option>
            {(locations ?? []).map((loc) => (
              <option key={loc.id} value={loc.id}>{loc.short_code} · {loc.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Report Content */}
      {activeReport === 'pnl' && <IncomeStatementReport startDate={startDate} endDate={endDate} locationId={locationId} />}
      {activeReport === 'bs' && <BalanceSheetReport asOfDate={endDate} locationId={locationId} />}
      {activeReport === 'tb' && <TrialBalanceReport locationId={locationId} />}
    </div>
  );
}

// ===== Income Statement =====

function IncomeStatementReport({ startDate, endDate, locationId }: { startDate: string; endDate: string; locationId: string }) {
  const params: Record<string, string> = { start_date: startDate, end_date: endDate };
  if (locationId !== 'all') params.location_id = locationId;

  const { data, isLoading, error } = useQuery<ISResponse>('/api/reports/income-statement', params);

  if (isLoading) return <div className="card p-12 flex items-center justify-center"><Loader2 size={24} className="animate-spin text-slate-500" /></div>;
  if (error) return <div className="card p-8 text-center"><AlertCircle size={24} className="mx-auto text-red-400 mb-2" /><p className="text-sm text-red-400">{error}</p></div>;
  if (!data) return <div className="card p-8 text-center text-sm text-slate-500">No data available for this period.</div>;

  const { sections, summary: s } = data;

  return (
    <div className="card overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-800">
        <h2 className="text-base font-semibold text-white">Income Statement</h2>
        <p className="text-2xs text-slate-500 mt-0.5 font-mono">{startDate} through {endDate}</p>
      </div>

      <table className="w-full">
        <thead>
          <tr className="border-b border-slate-800/50">
            <th className="px-6 py-2.5 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500 w-24">Account</th>
            <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Description</th>
            <th className="px-6 py-2.5 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Amount</th>
          </tr>
        </thead>
        <tbody>
          {sections.map((section) => (
            <SectionRows key={section.type} section={section} />
          ))}

          {/* Summary lines */}
          <SummaryLine label="Gross Profit" amount={s.grossProfitCents} pct={s.grossMarginPct} bold />
          <SummaryLine label="EBITDA" amount={s.ebitdaCents} />
          <SummaryLine label="Net Income" amount={s.netIncomeCents} pct={s.netMarginPct} bold highlight />
        </tbody>
      </table>
    </div>
  );
}

function SectionRows({ section }: { section: ISSection }) {
  return (
    <>
      {/* Section header */}
      <tr className="bg-slate-800/30">
        <td colSpan={2} className="px-6 py-2 text-xs font-semibold text-slate-300 uppercase tracking-wider">{section.label}</td>
        <td className="px-6 py-2 text-right text-xs font-mono tabular-nums font-semibold text-slate-300">
          {formatMoney(section.totalCents)}
        </td>
      </tr>
      {section.groups.map((group) => (
        <GroupRows key={group.name} group={group} />
      ))}
    </>
  );
}

function GroupRows({ group }: { group: { name: string; accounts: { accountNumber: string; accountName: string; amountCents: number }[]; totalCents: number } }) {
  if (group.accounts.length <= 1) {
    // Single account group — show inline
    const acct = group.accounts[0];
    if (!acct) return null;
    return (
      <tr className="table-row-hover">
        <td className="px-6 py-1.5 text-xs font-mono text-slate-500">{acct.accountNumber}</td>
        <td className="px-4 py-1.5 text-sm text-slate-300">{acct.accountName}</td>
        <td className="px-6 py-1.5 text-right text-sm font-mono tabular-nums text-slate-200">{formatMoney(acct.amountCents)}</td>
      </tr>
    );
  }

  return (
    <>
      {group.accounts.map((acct) => (
        <tr key={acct.accountNumber} className="table-row-hover">
          <td className="px-6 py-1.5 text-xs font-mono text-slate-500 pl-10">{acct.accountNumber}</td>
          <td className="px-4 py-1.5 text-sm text-slate-400">{acct.accountName}</td>
          <td className="px-6 py-1.5 text-right text-sm font-mono tabular-nums text-slate-300">{formatMoney(acct.amountCents)}</td>
        </tr>
      ))}
      <tr>
        <td></td>
        <td className="px-4 py-1 text-xs text-slate-500 font-medium">Total {group.name}</td>
        <td className="px-6 py-1 text-right text-xs font-mono tabular-nums text-slate-400 border-t border-slate-800/50">{formatMoney(group.totalCents)}</td>
      </tr>
    </>
  );
}

function SummaryLine({ label, amount, pct, bold, highlight }: { label: string; amount: number; pct?: number; bold?: boolean; highlight?: boolean }) {
  return (
    <tr className={clsx(highlight ? 'bg-brand-500/[0.04]' : 'bg-slate-800/20')}>
      <td></td>
      <td className={clsx('px-4 py-2.5', bold ? 'text-sm font-semibold text-white' : 'text-sm text-slate-300')}>{label}</td>
      <td className="px-6 py-2.5 text-right">
        <span className={clsx(
          'font-mono tabular-nums',
          bold ? 'text-base font-semibold' : 'text-sm font-medium',
          highlight ? (amount >= 0 ? 'text-emerald-400' : 'text-red-400') : 'text-white'
        )}>
          {formatMoney(amount)}
        </span>
        {pct !== undefined && (
          <span className="ml-2 text-2xs text-slate-500 font-mono">{pct}%</span>
        )}
      </td>
    </tr>
  );
}

// ===== Balance Sheet =====

function BalanceSheetReport({ asOfDate, locationId }: { asOfDate: string; locationId: string }) {
  const params: Record<string, string> = { as_of_date: asOfDate };
  if (locationId !== 'all') params.location_id = locationId;

  const { data, isLoading, error } = useQuery<BSResponse>('/api/reports/balance-sheet', params);

  if (isLoading) return <div className="card p-12 flex items-center justify-center"><Loader2 size={24} className="animate-spin text-slate-500" /></div>;
  if (error) return <div className="card p-8 text-center"><AlertCircle size={24} className="mx-auto text-red-400 mb-2" /><p className="text-sm text-red-400">{error}</p></div>;
  if (!data) return <div className="card p-8 text-center text-sm text-slate-500">No data.</div>;

  const { sections, summary: s } = data;

  return (
    <div className="card overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-white">Balance Sheet</h2>
          <p className="text-2xs text-slate-500 mt-0.5 font-mono">As of {asOfDate}</p>
        </div>
        {!s.isBalanced && (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-red-500/10 text-red-400">
            <AlertCircle size={12} />
            Out of balance by {formatMoney(Math.abs(s.varianceCents))}
          </span>
        )}
        {s.isBalanced && (
          <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium bg-emerald-500/10 text-emerald-400">
            Balanced ✓
          </span>
        )}
      </div>

      <table className="w-full">
        <thead>
          <tr className="border-b border-slate-800/50">
            <th className="px-6 py-2.5 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500 w-24">Account</th>
            <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Description</th>
            <th className="px-6 py-2.5 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Balance</th>
          </tr>
        </thead>
        <tbody>
          {sections.map((section) => (
            <BSTypeSection key={section.type} section={section} />
          ))}

          {/* Footer totals */}
          <tr className="bg-slate-800/30">
            <td></td>
            <td className="px-4 py-2.5 text-sm font-semibold text-white">Total Assets</td>
            <td className="px-6 py-2.5 text-right text-base font-mono tabular-nums font-semibold text-white">{formatMoney(s.totalAssetsCents)}</td>
          </tr>
          <tr className="bg-brand-500/[0.04]">
            <td></td>
            <td className="px-4 py-2.5 text-sm font-semibold text-white">Total Liabilities + Equity</td>
            <td className="px-6 py-2.5 text-right text-base font-mono tabular-nums font-semibold text-white">
              {formatMoney(s.totalLiabilitiesCents + s.totalEquityCents)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function BSTypeSection({ section }: { section: BSSection }) {
  return (
    <>
      <tr className="bg-slate-800/30">
        <td colSpan={2} className="px-6 py-2 text-xs font-semibold text-slate-300 uppercase tracking-wider">{section.label}</td>
        <td className="px-6 py-2 text-right text-xs font-mono tabular-nums font-semibold text-slate-300">{formatMoney(section.totalCents)}</td>
      </tr>
      {section.subTypes.map((st) => (
        <BSSubTypeSection key={st.name} subType={st} />
      ))}
    </>
  );
}

function BSSubTypeSection({ subType }: { subType: BSSubType }) {
  return (
    <>
      {subType.groups.map((group) => (
        group.accounts.map((acct) => (
          <tr key={acct.accountNumber} className="table-row-hover">
            <td className="px-6 py-1.5 text-xs font-mono text-slate-500 pl-10">{acct.accountNumber}</td>
            <td className="px-4 py-1.5 text-sm text-slate-400">{acct.accountName}</td>
            <td className="px-6 py-1.5 text-right text-sm font-mono tabular-nums text-slate-300">{formatMoney(acct.balanceCents)}</td>
          </tr>
        ))
      ))}
      <tr>
        <td></td>
        <td className="px-4 py-1 text-xs text-slate-500 font-medium">Total {subType.name}</td>
        <td className="px-6 py-1 text-right text-xs font-mono tabular-nums text-slate-400 border-t border-slate-800/50">{formatMoney(subType.totalCents)}</td>
      </tr>
    </>
  );
}

// ===== Trial Balance =====

function TrialBalanceReport({ locationId }: { locationId: string }) {
  const params: Record<string, string> = {};
  if (locationId !== 'all') params.location_id = locationId;

  const { data, isLoading, error } = useQuery<TBResponse>('/api/gl/trial-balance', params);

  if (isLoading) return <div className="card p-12 flex items-center justify-center"><Loader2 size={24} className="animate-spin text-slate-500" /></div>;
  if (error) return <div className="card p-8 text-center"><AlertCircle size={24} className="mx-auto text-red-400 mb-2" /><p className="text-sm text-red-400">{error}</p></div>;

  const rows = data?.data ?? [];
  if (rows.length === 0) return <div className="card p-8 text-center text-sm text-slate-500">No posted entries found.</div>;

  const totalDebits = rows.reduce((s, r) => s + Number(r.total_debits), 0);
  const totalCredits = rows.reduce((s, r) => s + Number(r.total_credits), 0);
  const isBalanced = totalDebits === totalCredits;

  return (
    <div className="card overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-white">Trial Balance</h2>
          <p className="text-2xs text-slate-500 mt-0.5">{rows.length} accounts with activity</p>
        </div>
        {isBalanced ? (
          <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium bg-emerald-500/10 text-emerald-400">Balanced ✓</span>
        ) : (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-red-500/10 text-red-400">
            <AlertCircle size={12} /> Out of balance
          </span>
        )}
      </div>

      <table className="w-full">
        <thead>
          <tr className="border-b border-slate-800/50">
            <th className="px-6 py-2.5 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500 w-24">Account</th>
            <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Name</th>
            <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Type</th>
            <th className="px-6 py-2.5 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Debits</th>
            <th className="px-6 py-2.5 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Credits</th>
            <th className="px-6 py-2.5 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Net Balance</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/30">
          {rows.map((row) => (
            <tr key={row.account_number} className="table-row-hover">
              <td className="px-6 py-1.5 text-xs font-mono text-slate-500">{row.account_number}</td>
              <td className="px-4 py-1.5 text-sm text-slate-300">{row.account_name}</td>
              <td className="px-4 py-1.5 text-2xs text-slate-500">{row.account_type}</td>
              <td className="px-6 py-1.5 text-right text-sm font-mono tabular-nums text-slate-300">
                {Number(row.total_debits) > 0 ? formatMoney(row.total_debits) : ''}
              </td>
              <td className="px-6 py-1.5 text-right text-sm font-mono tabular-nums text-slate-300">
                {Number(row.total_credits) > 0 ? formatMoney(row.total_credits) : ''}
              </td>
              <td className="px-6 py-1.5 text-right text-sm font-mono tabular-nums font-medium text-slate-200">
                {formatMoney(row.net_balance)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-slate-700 bg-slate-800/30">
            <td colSpan={3} className="px-6 py-2.5 text-sm font-semibold text-white">Totals</td>
            <td className="px-6 py-2.5 text-right text-sm font-mono tabular-nums font-semibold text-white">{formatMoney(totalDebits)}</td>
            <td className="px-6 py-2.5 text-right text-sm font-mono tabular-nums font-semibold text-white">{formatMoney(totalCredits)}</td>
            <td className="px-6 py-2.5 text-right text-sm font-mono tabular-nums font-semibold text-white">{formatMoney(totalDebits - totalCredits)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
