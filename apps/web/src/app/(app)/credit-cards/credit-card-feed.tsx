'use client';

import { useState, useCallback } from 'react';
import { Check, Flag, Pencil, Receipt, Bell, Clock, Inbox, AlertCircle, Loader2, Search } from 'lucide-react';
import { clsx } from 'clsx';
import { StatusBadge, ConfidenceBar, EmptyState, TableSkeleton } from '@/components/ui';
import { formatMoney } from '@meritbooks/shared';
import { useQuery, useMutation, useDebounce, addToast } from '@/hooks';
import type { ApproveBankTransactionInput } from '@/lib/validations/transactions';
import { CompanySelector } from '../bank-feed/company-selector';

interface CCRow {
  id: string;
  transaction_date: string;
  description: string;
  amount_cents: number;
  status: string;
  ai_confidence: number | null;
  ai_reasoning: string | null;
  location: { id: string; name: string; short_code: string } | null;
  ai_account: { id: string; account_number: string; name: string } | null;
  ai_vendor: { id: string; name: string; display_name: string | null } | null;
  final_account: { id: string; account_number: string; name: string } | null;
  bank_account: { id: string; account_name: string; account_mask: string } | null;
  receiptStatus: 'MATCHED' | 'MISSING' | 'PENDING';
  chaseCount: number;
}

interface CCResponse {
  data: CCRow[];
  counts: Record<string, { count: number; amount_cents: number }>;
  pagination: { page: number; per_page: number; total: number; total_pages: number };
}

interface ApproveResult {
  success: boolean;
  entry_number: string;
  transaction_id: string;
}

const TAB_CONFIG = [
  { key: 'all', label: 'All' },
  { key: 'PENDING', label: 'Pending' },
  { key: 'CATEGORIZED', label: 'Categorized' },
  { key: 'FLAGGED', label: 'Flagged' },
] as const;

function ReceiptBadge({ status, chaseCount }: { status: string; chaseCount: number }) {
  if (status === 'MATCHED') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-medium bg-emerald-500/10 text-emerald-400">
        <Receipt size={10} />
        Matched
      </span>
    );
  }
  if (status === 'MISSING') {
    return (
      <span className={clsx(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-medium',
        chaseCount >= 5 ? 'bg-red-500/10 text-red-400' : 'bg-amber-500/10 text-amber-400',
      )}>
        <Bell size={10} />
        Chase ({chaseCount})
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-medium bg-blue-500/10 text-blue-400">
      <Clock size={10} />
      Pending
    </span>
  );
}

export function CreditCardFeed() {
  const [activeTab, setActiveTab] = useState('all');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [approvingId, setApprovingId] = useState<string | null>(null);

  const params: Record<string, string> = {};
  if (activeTab !== 'all') params.status = activeTab;
  if (debouncedSearch) params.search = debouncedSearch;
  if (locationId) params.location_id = locationId;

  const { data, isLoading, error, refetch } = useQuery<CCResponse>(
    '/api/credit-cards',
    Object.keys(params).length > 0 ? params : undefined,
  );

  const { mutate: approveTxn } = useMutation<ApproveBankTransactionInput, ApproveResult>(
    '/api/bank-feed/approve'
  );

  const handleApprove = useCallback(async (txn: CCRow) => {
    const account = txn.final_account ?? txn.ai_account;
    if (!account) {
      addToast('error', 'No GL account assigned');
      return;
    }
    setApprovingId(txn.id);
    const result = await approveTxn({
      transaction_id: txn.id,
      account_id: account.id,
      vendor_id: txn.ai_vendor?.id ?? undefined,
    });
    if (result) {
      addToast('success', `Approved → ${result.entry_number}`);
      refetch();
    } else {
      addToast('error', 'Failed to approve');
    }
    setApprovingId(null);
  }, [approveTxn, refetch]);

  const transactions = data?.data ?? [];
  const counts = data?.counts ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <CompanySelector selectedId={locationId} onChange={setLocationId} />
      </div>

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
                {stats ? `${stats.count} · ${formatMoney(stats.amount_cents, { compact: true })}` : '--'}
              </span>
            </button>
          );
        })}
      </div>

      {/* Search */}
      <div className="relative max-w-md">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by vendor or description..."
          className="input pl-9"
        />
      </div>

      {/* Table */}
      {isLoading ? (
        <TableSkeleton rows={6} cols={8} />
      ) : error ? (
        <div className="card p-8 text-center">
          <AlertCircle size={24} className="mx-auto text-red-400 mb-2" />
          <p className="text-sm text-red-400 font-medium mb-1">Failed to load</p>
          <p className="text-xs text-slate-500">{error}</p>
        </div>
      ) : transactions.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No credit card transactions"
          description="No transactions match your filters. Try a different status or company."
        />
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Date</th>
                <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Description</th>
                <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Card</th>
                <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Company</th>
                <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">GL Category</th>
                <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500 w-20">Conf.</th>
                <th className="px-4 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Amount</th>
                <th className="px-4 py-3 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500">Receipt</th>
                <th className="w-24 px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/30">
              {transactions.map((txn) => {
                const account = txn.final_account ?? txn.ai_account;
                const vendor = txn.ai_vendor?.display_name ?? txn.ai_vendor?.name ?? null;
                const isPosted = txn.status === 'POSTED' || txn.status === 'APPROVED';
                return (
                  <tr key={txn.id} className="table-row-hover">
                    <td className="px-4 py-3 text-sm text-slate-400 font-mono tabular-nums whitespace-nowrap">
                      {txn.transaction_date}
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-sm text-slate-200 truncate max-w-[200px]">{txn.description}</p>
                      {vendor && <p className="text-2xs text-slate-500 mt-0.5">{vendor}</p>}
                    </td>
                    <td className="px-4 py-3">
                      {txn.bank_account ? (
                        <div>
                          <p className="text-sm text-slate-300">{txn.bank_account.account_name}</p>
                          <p className="text-2xs text-slate-500 font-mono">·{txn.bank_account.account_mask}</p>
                        </div>
                      ) : (
                        <span className="text-sm text-slate-600">--</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {txn.location ? (
                        <span className="text-2xs font-mono text-slate-500 bg-slate-800 px-1 py-0.5 rounded">
                          {txn.location.short_code}
                        </span>
                      ) : (
                        <span className="text-sm text-slate-600">--</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {account ? (
                        <span className="text-xs font-mono text-slate-400">
                          {account.account_number} · {account.name}
                        </span>
                      ) : (
                        <span className="text-xs text-amber-400 italic">Uncategorized</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {txn.ai_confidence != null && <ConfidenceBar value={txn.ai_confidence} />}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-mono tabular-nums text-slate-200">
                      {formatMoney(Math.abs(txn.amount_cents))}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <ReceiptBadge status={txn.receiptStatus} chaseCount={txn.chaseCount} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => handleApprove(txn)}
                          disabled={!account || approvingId === txn.id || isPosted}
                          className={clsx(
                            'p-1.5 rounded-md transition-colors',
                            !account || isPosted
                              ? 'text-slate-700 cursor-not-allowed'
                              : 'text-slate-500 hover:text-emerald-400 hover:bg-emerald-500/10'
                          )}
                          title="Approve"
                        >
                          {approvingId === txn.id ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                        </button>
                        <button className="p-1.5 rounded-md text-slate-500 hover:text-amber-400 hover:bg-amber-500/10 transition-colors" title="Flag">
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
