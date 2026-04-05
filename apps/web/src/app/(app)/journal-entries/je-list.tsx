'use client';

import { useState } from 'react';
import { Inbox, AlertCircle, Search } from 'lucide-react';
import { clsx } from 'clsx';
import { StatusBadge, EmptyState, TableSkeleton } from '@/components/ui';
import { formatMoney } from '@meritbooks/shared';
import { useQuery, useDebounce } from '@/hooks';
import { CompanySelector } from '../bank-feed/company-selector';

interface JERow {
  id: string;
  entryNumber: string;
  entryDate: string;
  entryType: string;
  memo: string | null;
  sourceModule: string | null;
  status: string;
  postedAt: string | null;
  createdBy: string;
  location: { id: string; name: string; short_code: string } | null;
  totalDebitCents: number;
  lineCount: number;
}

interface JEResponse {
  data: JERow[];
  counts: Record<string, number>;
  pagination: { page: number; per_page: number; total: number; total_pages: number };
}

const TABS = [
  { key: 'all', label: 'All' },
  { key: 'DRAFT', label: 'Draft' },
  { key: 'POSTED', label: 'Posted' },
  { key: 'VOIDED', label: 'Voided' },
] as const;

const SOURCE_LABELS: Record<string, { label: string; className: string }> = {
  BANK_FEED: { label: 'Bank Feed', className: 'text-blue-400 bg-blue-500/10' },
  BILL: { label: 'AP Bill', className: 'text-amber-400 bg-amber-500/10' },
  RECEIPT: { label: 'Receipt', className: 'text-purple-400 bg-purple-500/10' },
  PAYROLL: { label: 'Payroll', className: 'text-emerald-400 bg-emerald-500/10' },
  MANUAL: { label: 'Manual', className: 'text-slate-400 bg-slate-500/10' },
  REV_REC: { label: 'Rev Rec', className: 'text-indigo-400 bg-indigo-500/10' },
  DEPRECIATION: { label: 'Depreciation', className: 'text-slate-400 bg-slate-500/10' },
  CHARGEBACK: { label: 'Chargeback', className: 'text-orange-400 bg-orange-500/10' },
  INTERCOMPANY: { label: 'Interco', className: 'text-cyan-400 bg-cyan-500/10' },
  CASH_MGMT: { label: 'Cash Mgmt', className: 'text-blue-400 bg-blue-500/10' },
  SYSTEM: { label: 'System', className: 'text-slate-400 bg-slate-500/10' },
};

const TYPE_LABELS: Record<string, string> = {
  STANDARD: 'Standard',
  ADJUSTING: 'Adjusting',
  CLOSING: 'Closing',
  REVERSING: 'Reversing',
  RECURRING: 'Recurring',
  SYSTEM: 'System',
};

export function JournalEntryList() {
  const [activeTab, setActiveTab] = useState('all');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [locationId, setLocationId] = useState<string | null>(null);

  const params: Record<string, string> = {};
  if (activeTab !== 'all') params.status = activeTab;
  if (debouncedSearch) params.search = debouncedSearch;
  if (locationId) params.location_id = locationId;

  const { data, isLoading, error } = useQuery<JEResponse>(
    '/api/journal-entries',
    Object.keys(params).length > 0 ? params : undefined,
  );

  const entries = data?.data ?? [];
  const counts = data?.counts ?? null;

  return (
    <div className="space-y-4">
      <CompanySelector selectedId={locationId} onChange={setLocationId} />

      <div className="flex items-center gap-1 p-1 rounded-lg bg-surface-900 border border-slate-800 w-fit">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={clsx(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors',
              activeTab === tab.key
                ? 'bg-slate-800 text-white font-medium'
                : 'text-slate-400 hover:text-slate-300'
            )}
          >
            <span>{tab.label}</span>
            <span className={clsx(
              'text-2xs font-mono tabular-nums',
              activeTab === tab.key ? 'text-brand-400' : 'text-slate-600'
            )}>
              {counts ? counts[tab.key] ?? 0 : '--'}
            </span>
          </button>
        ))}
      </div>

      <div className="relative max-w-md">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by entry # or memo..."
          className="input pl-9"
        />
      </div>

      {isLoading ? (
        <TableSkeleton rows={8} cols={8} />
      ) : error ? (
        <div className="card p-8 text-center">
          <AlertCircle size={24} className="mx-auto text-red-400 mb-2" />
          <p className="text-sm text-red-400 font-medium">{error}</p>
        </div>
      ) : entries.length === 0 ? (
        <EmptyState icon={Inbox} title="No journal entries" description="No entries match your filters." />
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Entry #</th>
                <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Date</th>
                <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Source</th>
                <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Memo</th>
                <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Company</th>
                <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Type</th>
                <th className="px-4 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Debits</th>
                <th className="px-4 py-3 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500">Lines</th>
                <th className="px-4 py-3 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/30">
              {entries.map((je) => {
                const source = SOURCE_LABELS[je.sourceModule ?? ''] ?? SOURCE_LABELS.SYSTEM;
                return (
                  <tr key={je.id} className="table-row-hover">
                    <td className="px-4 py-3 text-sm font-mono text-slate-300 whitespace-nowrap">
                      {je.entryNumber}
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-400 font-mono tabular-nums whitespace-nowrap">
                      {je.entryDate}
                    </td>
                    <td className="px-4 py-3">
                      <span className={clsx('inline-flex items-center px-2 py-0.5 rounded-full text-2xs font-medium', source.className)}>
                        {source.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm text-slate-200 truncate block max-w-[250px]">{je.memo ?? '--'}</span>
                    </td>
                    <td className="px-4 py-3">
                      {je.location ? (
                        <span className="text-2xs font-mono text-slate-500 bg-slate-800 px-1 py-0.5 rounded">
                          {je.location.short_code}
                        </span>
                      ) : '--'}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-400">
                      {TYPE_LABELS[je.entryType] ?? je.entryType}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-mono tabular-nums text-slate-200">
                      {formatMoney(je.totalDebitCents)}
                    </td>
                    <td className="px-4 py-3 text-center text-xs text-slate-500 font-mono">
                      {je.lineCount}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <StatusBadge status={je.status} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
