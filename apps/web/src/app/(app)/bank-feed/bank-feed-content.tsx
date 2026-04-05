'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useDebounce, addToast } from '@/hooks';
import type { BankFeedResponse, BankFeedRow } from '@meritbooks/shared';
import type { ApproveBankTransactionInput } from '@/lib/validations/transactions';
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
      // Default directions: confidence asc, date desc, amount desc, rest asc
      setSortDir(field === 'date' || field === 'amount' ? 'desc' : 'asc');
    }
  }, [sortField]);

  // Approve mutation
  const { mutate: approveTxn, isLoading: isApproving } = useMutation<
    ApproveBankTransactionInput,
    ApproveResult
  >('/api/bank-feed/approve');

  const handleApprove = useCallback(async (txn: BankFeedRow) => {
    if (!txn.ai_account) {
      addToast('error', 'Cannot approve: no AI-suggested account');
      return;
    }
    const result = await approveTxn({
      transaction_id: txn.id,
      account_id: txn.ai_account.id,
      vendor_id: txn.ai_vendor?.id ?? undefined,
    });
    if (result) {
      addToast('success', `Approved → ${result.entry_number}`);
      refetch();
    } else {
      addToast('error', 'Failed to approve transaction');
    }
  }, [approveTxn, refetch]);

  // Batch approve
  const handleBatchApprove = useCallback(async (txnIds: string[]) => {
    let approved = 0;
    let failed = 0;
    for (const id of txnIds) {
      const txn = transactions.find((t) => t.id === id);
      if (txn?.ai_account) {
        const result = await approveTxn({
          transaction_id: id,
          account_id: txn.ai_account.id,
          vendor_id: txn.ai_vendor?.id ?? undefined,
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

  // Smart batch: select all with confidence >= 90%
  const selectHighConfidence = useCallback(() => {
    const highConf = transactions
      .filter((t) => (t.ai_confidence ?? 0) >= 0.9 && t.ai_account)
      .map((t) => t.id);
    setSelected(new Set(highConf));
  }, [transactions]);

  // Vendor batch: select all transactions from a given vendor
  const selectByVendor = useCallback((vendorName: string) => {
    const ids = transactions
      .filter((t) => {
        const name = t.ai_vendor?.display_name ?? t.ai_vendor?.name ?? '';
        return name === vendorName;
      })
      .map((t) => t.id);
    setSelected((prev) => {
      const next = new Set(prev);
      // Toggle: if all already selected, deselect them
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
      // Don't capture when typing in inputs or when edit panel is open
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (editingTxn) return;

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
            addToast('error', 'Flag endpoint not yet implemented');
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
  }, [transactions, focusedIndex, handleApprove, handleEdit, toggleSelect, editingTxn]);

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
      />
      {editingTxn && (
        <EditPanel
          transaction={editingTxn}
          locationId={selectedLocationId}
          onClose={handleEditClose}
          onSave={handleEditSave}
        />
      )}
    </>
  );
}
