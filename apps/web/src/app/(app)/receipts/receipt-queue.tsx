'use client';

import { useState, useCallback } from 'react';
import { Check, Flag, Camera, Mail, Upload, Inbox, AlertCircle, Loader2, Search, Bell } from 'lucide-react';
import { clsx } from 'clsx';
import { StatusBadge, ConfidenceBar, EmptyState, TableSkeleton } from '@/components/ui';
import { formatMoney } from '@meritbooks/shared';
import { useQuery, useMutation, useDebounce, addToast } from '@/hooks';
import type { ApproveReceiptInput } from '@/lib/validations/transactions';
import { CompanySelector } from '../bank-feed/company-selector';

interface ReceiptRow {
  id: string;
  submitted_at: string;
  receipt_date: string | null;
  vendor_name: string | null;
  amount_cents: number | null;
  source: 'MOBILE_CAPTURE' | 'EMAIL' | 'MANUAL_UPLOAD';
  status: string;
  ai_confidence: number | null;
  chase_reminder_count: number;
  location: { id: string; name: string; short_code: string } | null;
  account: { id: string; account_number: string; name: string } | null;
  vendor: { id: string; name: string } | null;
}

interface ReceiptResponse {
  data: ReceiptRow[];
  counts: Record<string, { count: number; amount_cents: number }>;
  pagination: { page: number; per_page: number; total: number; total_pages: number };
}

interface ApproveResult {
  success: boolean;
  entry_number: string;
}

const SOURCE_ICONS = {
  MOBILE_CAPTURE: { icon: Camera, label: 'Mobile', className: 'text-blue-400 bg-blue-500/10' },
  EMAIL: { icon: Mail, label: 'Email', className: 'text-purple-400 bg-purple-500/10' },
  MANUAL_UPLOAD: { icon: Upload, label: 'Upload', className: 'text-slate-400 bg-slate-500/10' },
};

const TAB_CONFIG = [
  { key: 'all', label: 'All' },
  { key: 'PENDING', label: 'Pending' },
  { key: 'CATEGORIZED', label: 'Categorized' },
  { key: 'FLAGGED', label: 'Flagged' },
] as const;

export function ReceiptQueue() {
  const [activeTab, setActiveTab] = useState('all');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [approvingId, setApprovingId] = useState<string | null>(null);

  const params: Record<string, string> = {};
  if (activeTab !== 'all') params.status = activeTab;
  if (debouncedSearch) params.search = debouncedSearch;
  if (locationId) params.location_id = locationId;

  const { data, isLoading, error, refetch } = useQuery<ReceiptResponse>(
    '/api/receipts',
    Object.keys(params).length > 0 ? params : undefined,
  );

  const { mutate: approveReceipt } = useMutation<ApproveReceiptInput, ApproveResult>(
    '/api/receipts/approve'
  );

  const handleApprove = useCallback(async (r: ReceiptRow) => {
    if (!r.account || !r.amount_cents || !r.receipt_date) {
      addToast('error', 'Receipt missing required fields (account, amount, or date)');
      return;
    }
    setApprovingId(r.id);
    const result = await approveReceipt({
      receipt_id: r.id,
      account_id: r.account.id,
      vendor_id: r.vendor?.id ?? undefined,
      amount_cents: r.amount_cents,
      receipt_date: r.receipt_date,
    });
    if (result) {
      addToast('success', `Receipt approved`);
      refetch();
    } else {
      addToast('error', 'Failed to approve receipt');
    }
    setApprovingId(null);
  }, [approveReceipt, refetch]);

  const receipts = data?.data ?? [];
  const counts = data?.counts ?? null;

  return (
    <div className="space-y-4">
      <CompanySelector selectedId={locationId} onChange={setLocationId} />

      {/* Status tabs */}
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
                {stats ? stats.count : '--'}
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
          placeholder="Search by vendor name..."
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
      ) : receipts.length === 0 ? (
        <EmptyState icon={Inbox} title="No receipts" description="No receipts match your filters." />
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Date</th>
                <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Vendor</th>
                <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Source</th>
                <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Company</th>
                <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">GL Category</th>
                <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500 w-20">Conf.</th>
                <th className="px-4 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Amount</th>
                <th className="px-4 py-3 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500">Status</th>
                <th className="w-20 px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/30">
              {receipts.map((r) => {
                const sourceConfig = SOURCE_ICONS[r.source];
                const SourceIcon = sourceConfig.icon;
                const isPosted = r.status === 'POSTED' || r.status === 'APPROVED';
                return (
                  <tr key={r.id} className="table-row-hover">
                    <td className="px-4 py-3 text-sm text-slate-400 font-mono tabular-nums whitespace-nowrap">
                      {r.receipt_date ?? r.submitted_at?.split('T')[0] ?? '--'}
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-sm text-slate-200">{r.vendor_name ?? r.vendor?.name ?? 'Unknown'}</p>
                      {r.chase_reminder_count > 0 && (
                        <span className="inline-flex items-center gap-1 text-2xs text-amber-400 mt-0.5">
                          <Bell size={9} />
                          {r.chase_reminder_count} reminders
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={clsx('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-medium', sourceConfig.className)}>
                        <SourceIcon size={10} />
                        {sourceConfig.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {r.location ? (
                        <span className="text-2xs font-mono text-slate-500 bg-slate-800 px-1 py-0.5 rounded">
                          {r.location.short_code}
                        </span>
                      ) : '--'}
                    </td>
                    <td className="px-4 py-3">
                      {r.account ? (
                        <span className="text-xs font-mono text-slate-400">{r.account.account_number} · {r.account.name}</span>
                      ) : (
                        <span className="text-xs text-amber-400 italic">Uncategorized</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {r.ai_confidence != null && <ConfidenceBar value={r.ai_confidence} />}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-mono tabular-nums text-slate-200">
                      {r.amount_cents != null ? formatMoney(r.amount_cents) : '--'}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => handleApprove(r)}
                          disabled={!r.account || !r.amount_cents || isPosted || approvingId === r.id}
                          className={clsx(
                            'p-1.5 rounded-md transition-colors',
                            !r.account || !r.amount_cents || isPosted
                              ? 'text-slate-700 cursor-not-allowed'
                              : 'text-slate-500 hover:text-emerald-400 hover:bg-emerald-500/10'
                          )}
                        >
                          {approvingId === r.id ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                        </button>
                        <button className="p-1.5 rounded-md text-slate-500 hover:text-amber-400 hover:bg-amber-500/10 transition-colors">
                          <Flag size={14} />
                        </button>
                      </div>
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
