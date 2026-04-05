'use client';

import { useState } from 'react';
import { AlertTriangle, Shield, Inbox, AlertCircle, Search, ShieldAlert, Clock } from 'lucide-react';
import { clsx } from 'clsx';
import { StatusBadge, EmptyState, TableSkeleton } from '@/components/ui';
import { formatMoney } from '@meritbooks/shared';
import { useQuery, useDebounce } from '@/hooks';
import { CompanySelector } from '../bank-feed/company-selector';

interface BillRow {
  id: string;
  bill_number: string | null;
  bill_date: string;
  due_date: string;
  total_cents: number;
  amount_paid_cents: number;
  balance_cents: number;
  status: string;
  ai_extracted: boolean;
  ai_confidence: number | null;
  payment_hold_reason: string | null;
  daysUntilDue: number | null;
  location: { id: string; name: string; short_code: string } | null;
  vendor: { id: string; name: string; display_name: string | null; is_1099_eligible: boolean } | null;
  compliance: { missing: string[]; hasHold: boolean } | null;
}

interface BillResponse {
  data: BillRow[];
  counts: Record<string, { count: number; amount_cents: number }>;
  pagination: { page: number; per_page: number; total: number; total_pages: number };
}

const TAB_CONFIG = [
  { key: 'all', label: 'All Open' },
  { key: 'PENDING', label: 'Pending' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'ON_HOLD', label: 'On Hold' },
] as const;

export function BillList() {
  const [activeTab, setActiveTab] = useState('all');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [locationId, setLocationId] = useState<string | null>(null);

  const params: Record<string, string> = {};
  if (activeTab !== 'all') params.status = activeTab;
  if (debouncedSearch) params.search = debouncedSearch;
  if (locationId) params.location_id = locationId;

  const { data, isLoading, error } = useQuery<BillResponse>(
    '/api/bills',
    Object.keys(params).length > 0 ? params : undefined,
  );

  const bills = data?.data ?? [];
  const counts = data?.counts ?? null;

  return (
    <div className="space-y-4">
      <CompanySelector selectedId={locationId} onChange={setLocationId} />

      <div className="flex items-center gap-1 p-1 rounded-lg bg-surface-900 border border-slate-800 w-fit">
        {TAB_CONFIG.map((tab) => {
          const stats = counts?.[tab.key] ?? null;
          return (
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
                {stats ? `${stats.count} · ${formatMoney(stats.amount_cents, { compact: true })}` : '--'}
              </span>
            </button>
          );
        })}
      </div>

      <div className="relative max-w-md">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by bill number..."
          className="input pl-9"
        />
      </div>

      {isLoading ? (
        <TableSkeleton rows={6} cols={8} />
      ) : error ? (
        <div className="card p-8 text-center">
          <AlertCircle size={24} className="mx-auto text-red-400 mb-2" />
          <p className="text-sm text-red-400 font-medium">{error}</p>
        </div>
      ) : bills.length === 0 ? (
        <EmptyState icon={Inbox} title="No bills" description="No bills match your filters." />
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Bill #</th>
                <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Vendor</th>
                <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Company</th>
                <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Bill Date</th>
                <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Due</th>
                <th className="px-4 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Amount</th>
                <th className="px-4 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Balance</th>
                <th className="px-4 py-3 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/30">
              {bills.map((bill) => {
                const vendorName = bill.vendor?.display_name ?? bill.vendor?.name ?? 'Unknown';
                const hasComplianceIssue = bill.compliance && (bill.compliance.missing.length > 0 || bill.compliance.hasHold);
                const isOverdue = bill.daysUntilDue !== null && bill.daysUntilDue < 0;
                const isDueSoon = bill.daysUntilDue !== null && bill.daysUntilDue >= 0 && bill.daysUntilDue <= 7;

                return (
                  <tr key={bill.id} className="table-row-hover">
                    <td className="px-4 py-3">
                      <span className="text-sm font-mono text-slate-300">{bill.bill_number ?? '--'}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-slate-200">{vendorName}</span>
                        {hasComplianceIssue && (
                          <span
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs font-medium bg-red-500/10 text-red-400"
                            title={bill.compliance?.missing.join(', ') ?? 'Payment hold'}
                          >
                            <ShieldAlert size={10} />
                            {bill.compliance?.hasHold ? 'HOLD' : 'Docs'}
                          </span>
                        )}
                        {bill.vendor?.is_1099_eligible && (
                          <span className="text-2xs text-slate-600 font-mono">1099</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {bill.location ? (
                        <span className="text-2xs font-mono text-slate-500 bg-slate-800 px-1 py-0.5 rounded">
                          {bill.location.short_code}
                        </span>
                      ) : '--'}
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-400 font-mono tabular-nums">
                      {bill.bill_date}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <span className={clsx(
                          'text-sm font-mono tabular-nums',
                          isOverdue ? 'text-red-400' : isDueSoon ? 'text-amber-400' : 'text-slate-400'
                        )}>
                          {bill.due_date}
                        </span>
                        {isOverdue && (
                          <span className="text-2xs text-red-400 font-medium">
                            {Math.abs(bill.daysUntilDue!)}d late
                          </span>
                        )}
                        {isDueSoon && !isOverdue && (
                          <Clock size={10} className="text-amber-400" />
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-mono tabular-nums text-slate-200">
                      {formatMoney(bill.total_cents)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={clsx(
                        'text-sm font-mono tabular-nums font-medium',
                        bill.balance_cents > 0 ? 'text-slate-200' : 'text-emerald-400'
                      )}>
                        {formatMoney(bill.balance_cents)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <StatusBadge status={bill.status} />
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
