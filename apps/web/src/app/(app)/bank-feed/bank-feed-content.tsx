'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useDebounce, addToast } from '@/hooks';
import type { BankFeedResponse, BankFeedRow } from '@meritbooks/shared';
import type { ApproveBankTransactionInput, FlagTransactionInput } from '@/lib/validations/transactions';
import { BankFeedFilters } from './bank-feed-filters';
import { BankFeedList } from './bank-feed-list';
import { BankFeedMetricsStrip } from './bank-feed-metrics';
import { EditPanel } from './edit-panel';
import { CompanySelector } from './company-selector';

interface ApproveResult {
  success: boolean;
  entry_number: string;
  transaction_id: string;
}

interface FlagResult {
  success: boolean;
  transaction_id: string;
  status: string;
}

interface InlineUpdateResult {
  success: boolean;
  transaction: unknown;
  changed: string[];
}

export type SortField = 'date' | 'amount' | 'confidence' | 'vendor' | 'company';
export type SortDir = 'asc' | 'desc';

function sortTransactions(txns: BankFeedRow[], field: SortField, dir: SortDir): BankFeedRow[] {
  const mult = dir === 'asc' ? 1 : -1;
  return [...txns].sort((a, b) => {
    switch (field) {
      case 'date':
        return mult * a.transaction_date.localeCompare(b.transaction_date);
      case 'amount':
        return mult * (Math.abs(a.amount_cents) - Math.abs(b.amount_cents));
      case 'confidence':
        return mult * ((a.ai_confidence ?? -1) - (b.ai_confidence ?? -1));
      case 'vendor': {
        const va = a.ai_vendor?.name ?? '';
        const vb = b.ai_vendor?.name ?? '';
        return mult * va.localeCompare(vb);
      }
      case 'company': {
        const la = a.location?.name ?? '';
        const lb = b.location?.name ?? '';
        return mult * la.localeCompare(lb);
      }
      default:
        return 0;
    }
  });
}

export function BankFeedContent() {
  const [activeTab, setActiveTab] = useState<string>('all');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sortField, setSortField] = useState<SortField>('confidence');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [editingTxn, setEditingTxn] = useState<BankFeedRow | null>(null);
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
  const [flaggingTxn, setFlaggingTxn] = useState<BankFeedRow | null>(null);

  // Build query params
  const params: Record<string, string> = {};
  if (activeTab !== 'all') params.status = activeTab;
  if (debouncedSearch) params.search = debouncedSearch;
  if (selectedLocationId) params.location_id = selectedLocationId;

  const { data, isLoading, error, refetch } = useQuery<BankFeedResponse>(
    '/api/bank-feed',
    Object.keys(params).length > 0 ? params : undefined,
  );

  // Client-side sorting (default: confidence ascending = lowest first)
  const transactions = useMemo(
    () => sortTransactions(data?.data ?? [], sortField, sortDir),
    [data?.data, sortField, sortDir]
  );

  // Sort handler
  const handleSort = useCallback((field: SortField) => {
    if (field === sortField) {
      setSortDir((prev) => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir(field === 'date' || field === 'amount' ? 'desc' : 'asc');
    }
  }, [sortField]);

  // Approve mutation
  const { mutate: approveTxn, isLoading: isApproving } = useMutation<
    ApproveBankTransactionInput,
    ApproveResult
  >('/api/bank-feed/approve');

  // Flag mutation
  const { mutate: flagTxn, isLoading: isFlagging } = useMutation<
    FlagTransactionInput,
    FlagResult
  >('/api/bank-feed/flag');

  const handleApprove = useCallback(async (txn: BankFeedRow) => {
    const account = txn.final_account ?? txn.ai_account;
    if (!account) {
      addToast('error', 'Cannot approve: no GL account assigned');
      return;
    }
    const result = await approveTxn({
      transaction_id: txn.id,
      account_id: account.id,
      vendor_id: txn.ai_vendor?.id ?? undefined,
      job_id: txn.final_job?.id ?? undefined,
    });
    if (result) {
      addToast('success', `Approved → ${result.entry_number}`);
      refetch();
    } else {
      addToast('error', 'Failed to approve transaction');
    }
  }, [approveTxn, refetch]);

  // Flag handler
  const handleFlag = useCallback((txn: BankFeedRow) => {
    setFlaggingTxn(txn);
  }, []);

  const handleFlagSubmit = useCallback(async (reason: string) => {
    if (!flaggingTxn) return;
    const result = await flagTxn({
      transaction_id: flaggingTxn.id,
      reason,
    });
    if (result?.success) {
      addToast('success', 'Transaction flagged for review');
      setFlaggingTxn(null);
      refetch();
    } else {
      addToast('error', 'Failed to flag transaction');
    }
  }, [flaggingTxn, flagTxn, refetch]);

  // Inline update handler (for GL account or job changes from the table)
  const handleInlineUpdate = useCallback(async (
    txnId: string,
    updates: { final_account_id?: string; final_job_id?: string | null }
  ) => {
    try {
      const res = await fetch(`/api/bank-feed/${txnId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const result: InlineUpdateResult = await res.json();
      if (result.success) {
        addToast('success', `Updated ${result.changed.join(', ').replace(/final_/g, '')}`);
        refetch();
      } else {
        addToast('error', 'Failed to update');
      }
    } catch {
      addToast('error', 'Network error updating transaction');
    }
  }, [refetch]);

  // Batch approve
  const handleBatchApprove = useCallback(async (txnIds: string[]) => {
    let approved = 0;
    let failed = 0;
    for (const id of txnIds) {
      const txn = transactions.find((t) => t.id === id);
      const account = txn?.final_account ?? txn?.ai_account;
      if (account) {
        const result = await approveTxn({
          transaction_id: id,
          account_id: account.id,
          vendor_id: txn?.ai_vendor?.id ?? undefined,
          job_id: txn?.final_job?.id ?? undefined,
        });
        if (result) approved++;
        else failed++;
      } else {
        failed++;
      }
    }
    if (approved > 0) {
      addToast('success', `Batch approved ${approved} transaction${approved > 1 ? 's' : ''}`);
    }
    if (failed > 0) {
      addToast('error', `${failed} transaction${failed > 1 ? 's' : ''} could not be approved`);
    }
    setSelected(new Set());
    refetch();
  }, [transactions, approveTxn, refetch]);

  // Selection handlers
  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    if (selected.size === transactions.length && transactions.length > 0) {
      setSelected(new Set());
    } else {
      setSelected(new Set(transactions.map((t) => t.id)));
    }
  }, [selected.size, transactions]);

  const selectHighConfidence = useCallback(() => {
    const highConf = transactions
      .filter((t) => (t.ai_confidence ?? 0) >= 0.9 && (t.final_account ?? t.ai_account))
      .map((t) => t.id);
    setSelected(new Set(highConf));
  }, [transactions]);

  const selectByVendor = useCallback((vendorName: string) => {
    const ids = transactions
      .filter((t) => {
        const name = t.ai_vendor?.display_name ?? t.ai_vendor?.name ?? '';
        return name === vendorName;
      })
      .map((t) => t.id);
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = ids.every((id) => next.has(id));
      if (allSelected) {
        ids.forEach((id) => next.delete(id));
      } else {
        ids.forEach((id) => next.add(id));
      }
      return next;
    });
  }, [transactions]);

  // Edit panel
  const handleEdit = useCallback((txn: BankFeedRow) => {
    setEditingTxn(txn);
  }, []);

  const handleEditClose = useCallback(() => {
    setEditingTxn(null);
  }, []);

  const handleEditSave = useCallback(() => {
    setEditingTxn(null);
    refetch();
  }, [refetch]);

  // Reset focus when data changes
  useEffect(() => {
    setFocusedIndex(-1);
  }, [activeTab, debouncedSearch]);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (editingTxn || flaggingTxn) return;

      const len = transactions.length;
      if (len === 0) return;

      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          e.preventDefault();
          setFocusedIndex((prev) => Math.min(prev + 1, len - 1));
          break;
        case 'k':
        case 'ArrowUp':
          e.preventDefault();
          setFocusedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case 'a': {
          if (focusedIndex >= 0 && focusedIndex < len) {
            e.preventDefault();
            handleApprove(transactions[focusedIndex]);
          }
          break;
        }
        case 'e': {
          if (focusedIndex >= 0 && focusedIndex < len) {
            e.preventDefault();
            handleEdit(transactions[focusedIndex]);
          }
          break;
        }
        case 'f': {
          if (focusedIndex >= 0 && focusedIndex < len) {
            e.preventDefault();
            handleFlag(transactions[focusedIndex]);
          }
          break;
        }
        case ' ': {
          if (focusedIndex >= 0 && focusedIndex < len) {
            e.preventDefault();
            toggleSelect(transactions[focusedIndex].id);
          }
          break;
        }
        case 'Escape':
          setSelected(new Set());
          setFocusedIndex(-1);
          break;
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [transactions, focusedIndex, handleApprove, handleEdit, handleFlag, toggleSelect, editingTxn, flaggingTxn]);

  // Reset selection when location changes
  useEffect(() => {
    setSelected(new Set());
    setFocusedIndex(-1);
  }, [selectedLocationId]);

  return (
    <>
      <div className="mb-4">
        <CompanySelector selectedId={selectedLocationId} onChange={setSelectedLocationId} />
      </div>
      <BankFeedFilters
        activeTab={activeTab}
        onTabChange={setActiveTab}
        search={search}
        onSearchChange={setSearch}
        counts={data?.counts ?? null}
      />
      <BankFeedMetricsStrip metrics={data?.metrics ?? null} isLoading={isLoading} />
      <BankFeedList
        transactions={transactions}
        isLoading={isLoading}
        error={error}
        onApprove={handleApprove}
        isApproving={isApproving}
        onBatchApprove={handleBatchApprove}
        onFlag={handleFlag}
        onInlineUpdate={handleInlineUpdate}
        focusedIndex={focusedIndex}
        selected={selected}
        onToggleSelect={toggleSelect}
        onToggleAll={toggleAll}
        onSelectHighConfidence={selectHighConfidence}
        onSelectByVendor={selectByVendor}
        onEdit={handleEdit}
        sortField={sortField}
        sortDir={sortDir}
        onSort={handleSort}
        selectedLocationId={selectedLocationId}
      />
      {editingTxn && (
        <EditPanel
          transaction={editingTxn}
          locationId={selectedLocationId}
          onClose={handleEditClose}
          onSave={handleEditSave}
        />
      )}
      {/* Flag Dialog */}
      {flaggingTxn && (
        <FlagDialog
          transaction={flaggingTxn}
          isLoading={isFlagging}
          onSubmit={handleFlagSubmit}
          onClose={() => setFlaggingTxn(null)}
        />
      )}
    </>
  );
}

// --- Flag Dialog Component ---

function FlagDialog({
  transaction,
  isLoading,
  onSubmit,
  onClose,
}: {
  transaction: BankFeedRow;
  isLoading: boolean;
  onSubmit: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} />
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[440px] max-w-[90vw] bg-surface-900 border border-slate-800 rounded-xl shadow-2xl z-50 p-6">
        <h3 className="text-lg font-semibold text-white mb-1">Flag for Review</h3>
        <p className="text-sm text-slate-400 mb-4 truncate">{transaction.description}</p>
        <label className="block text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-2">
          Reason <span className="text-red-400">*</span>
        </label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why does this need manager review?"
          rows={3}
          autoFocus
          className="w-full px-3 py-2 rounded-md bg-slate-800/60 border border-slate-700 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-amber-500/40 focus:border-amber-500/40 resize-none"
        />
        <div className="flex items-center justify-end gap-3 mt-4">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-md text-sm text-slate-400 hover:text-slate-200 hover:bg-white/[0.04] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onSubmit(reason)}
            disabled={reason.trim().length === 0 || isLoading}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium bg-amber-600 text-white hover:bg-amber-500 disabled:bg-slate-800 disabled:text-slate-600 disabled:cursor-not-allowed transition-colors"
          >
            Flag Transaction
          </button>
        </div>
      </div>
    </>
  );
}
