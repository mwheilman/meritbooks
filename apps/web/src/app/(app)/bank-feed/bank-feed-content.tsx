'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useDebounce, addToast } from '@/hooks';
import { formatMoney, type BankFeedResponse, type BankFeedRow } from '@meritbooks/shared';
import type { ApproveBankTransactionInput, FlagTransactionInput } from '@/lib/validations/transactions';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { isSpecificCompany } from '@/lib/company-scope';
import { BankFeedFilters } from './bank-feed-filters';
import { BankFeedList } from './bank-feed-list';
import { BankFeedMetricsStrip } from './bank-feed-metrics';
import { EditPanel } from './edit-panel';
import { StatementImport } from './statement-import';
import { FileUp, RefreshCw, Copy, X } from 'lucide-react';

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

interface PlaidStatusResponse {
  ok: boolean;
  items: Array<{ id: string; institution_name: string | null; status: string; status_detail: string | null; last_synced_at: string | null }>;
  accountCount: number;
  connected: boolean;
}

interface SyncSummary {
  itemsSynced: number;
  transactionsAdded: number;
  transactionsModified: number;
  transactionsRemoved: number;
  balancesRefreshed: number;
  reauthNeeded: Array<{ plaidItemId: string; institutionName: string | null }>;
  errors: Array<{ plaidItemId: string; message: string }>;
}

interface DuplicateGroup {
  key: string;
  amountCents: number;
  sampleDescription: string;
  transactionIds: string[];
  dates: string[];
  count: number;
  hasOpen: boolean;
}

interface DuplicatesResponse {
  groups: DuplicateGroup[];
  duplicate_ids: string[];
  total_flagged: number;
  group_count: number;
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
  // Deep-link: ?id=<uuid> opens the edit panel for that transaction once the feed
  // loads it (e.g. an Explain "based on" link). Held pending until the row is in
  // the loaded set; a bad/missing id simply leaves the list, as before.
  const [pendingExplainId, setPendingExplainId] = useState<string | null>(null);
  // Company scope is now owned by the header + active-company context (the page is
  // behind <CompanyScopeGuard>, so a specific company is always active here). The
  // former in-page CompanySelector is retired; we derive the location from the
  // shared active company. useQuery also auto-attaches this as `location_id`.
  const { activeCompanyId } = useActiveCompany();
  const selectedLocationId = isSpecificCompany(activeCompanyId) ? activeCompanyId : null;
  const [flaggingTxn, setFlaggingTxn] = useState<BankFeedRow | null>(null);
  const [isCategorizing, setIsCategorizing] = useState(false);
  const [showStatementImport, setShowStatementImport] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [dupBannerDismissed, setDupBannerDismissed] = useState(false);

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

  // Plaid connection status (drives the Refresh button's enabled/last-synced state).
  const { data: plaidStatus, refetch: refetchStatus } = useQuery<PlaidStatusResponse>(
    '/api/integrations/plaid/sync',
  );
  const lastSyncedLabel = useMemo(() => {
    const times = (plaidStatus?.items ?? [])
      .map((i) => i.last_synced_at)
      .filter((t): t is string => !!t)
      .map((t) => new Date(t).getTime())
      .filter((n) => Number.isFinite(n));
    if (times.length === 0) return null;
    const mins = Math.round((Date.now() - Math.max(...times)) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
  }, [plaidStatus?.items]);

  // Duplicate detection (detect-only): flag likely double-imported transactions.
  const dupParams: Record<string, string> = {};
  if (selectedLocationId) dupParams.location_id = selectedLocationId;
  const { data: duplicates, refetch: refetchDuplicates } = useQuery<DuplicatesResponse>(
    '/api/bank-feed/duplicates',
    Object.keys(dupParams).length > 0 ? dupParams : undefined,
  );
  const duplicateIds = useMemo(
    () => new Set(duplicates?.duplicate_ids ?? []),
    [duplicates?.duplicate_ids],
  );
  useEffect(() => {
    setDupBannerDismissed(false);
  }, [selectedLocationId]);

  // Deep-link (?id=<uuid>): capture on load, then open the edit panel once the
  // feed has loaded that transaction. Keep the URL in sync while a panel is open
  // so the record is shareable. A bad/missing id just leaves the list.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('id');
    if (id) setPendingExplainId(id);
  }, []);
  useEffect(() => {
    if (!pendingExplainId) return;
    const match = (data?.data ?? []).find((t) => t.id === pendingExplainId);
    if (match) {
      setEditingTxn(match);
      setPendingExplainId(null);
    }
  }, [pendingExplainId, data]);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (editingTxn) url.searchParams.set('id', editingTxn.id);
    else url.searchParams.delete('id');
    window.history.replaceState(null, '', url.toString());
  }, [editingTxn]);

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
  // Inline approve uses a direct fetch (see handleApprove) so the server's real
  // error surfaces; this local flag drives the row button's loading state.
  const [isApproving, setIsApproving] = useState(false);

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
    setIsApproving(true);
    try {
      const res = await fetch('/api/bank-feed/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transaction_id: txn.id,
          account_id: account.id,
          vendor_id: txn.ai_vendor?.id ?? undefined,
          job_id: txn.final_job?.id ?? undefined,
        }),
      });
      const result = await res.json().catch(() => ({}));
      if (res.ok && result?.success) {
        addToast('success', `Approved → ${result.entry_number}`);
        refetch();
      } else {
        addToast('error', result?.error ?? 'Failed to approve transaction');
      }
    } catch {
      addToast('error', 'Network error while approving');
    } finally {
      setIsApproving(false);
    }
  }, [refetch]);

  // AI-categorize uncoded PENDING transactions in place (populates the ai_* columns
  // the list already renders; reviewer then approves with final ?? ai).
  const handleCategorizeAll = useCallback(async () => {
    setIsCategorizing(true);
    try {
      const res = await fetch('/api/bank-feed/categorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all_pending: true, location_id: selectedLocationId ?? undefined }),
      });
      const result = await res.json();
      if (res.ok && result.ok) {
        if (result.coded > 0) {
          addToast('success', `AI coded ${result.coded} transaction${result.coded > 1 ? 's' : ''}${result.failed ? `, ${result.failed} need attention` : ''}`);
        } else if (result.processed === 0) {
          addToast('success', 'Nothing to categorize — no uncoded pending transactions');
        } else {
          addToast('error', `Could not code any of ${result.processed} transaction${result.processed > 1 ? 's' : ''}`);
        }
        refetch();
      } else if (res.status === 402) {
        addToast('error', 'AI budget reached — categorization paused');
      } else {
        addToast('error', result.error ?? 'Categorization failed');
      }
    } catch {
      addToast('error', 'Network error during categorization');
    } finally {
      setIsCategorizing(false);
    }
  }, [selectedLocationId, refetch]);

  // Refresh / sync: pull the latest transactions via the existing Plaid sync path.
  // Degrade-safe — never duplicates already-imported rows (the sync service dedupes
  // on plaid_transaction_id) and reports clearly when no bank is connected.
  const handleSync = useCallback(async () => {
    if (isSyncing) return;
    if (plaidStatus && plaidStatus.connected === false) {
      addToast('error', 'No bank connected yet — link an account under Integrations to sync.');
      return;
    }
    setIsSyncing(true);
    try {
      const res = await fetch('/api/integrations/plaid/sync', { method: 'POST' });
      const result = await res.json().catch(() => ({}));
      if (res.ok && result?.ok) {
        const s = result.summary as SyncSummary;
        if (!s || s.itemsSynced === 0) {
          addToast('error', 'No bank connected yet — link an account under Integrations to sync.');
        } else {
          const added = s.transactionsAdded ?? 0;
          const modified = s.transactionsModified ?? 0;
          if (added === 0 && modified === 0) {
            addToast('success', 'Up to date — no new transactions.');
          } else {
            addToast(
              'success',
              `Synced ${added} new${modified ? `, ${modified} updated` : ''} transaction${added === 1 && !modified ? '' : 's'}.`,
            );
          }
          if (s.reauthNeeded?.length) {
            addToast('error', `Reconnect needed: ${s.reauthNeeded.map((r) => r.institutionName ?? 'a bank').join(', ')}.`);
          }
          if (s.errors?.length) {
            addToast('error', `${s.errors.length} connection${s.errors.length > 1 ? 's' : ''} could not sync.`);
          }
        }
        refetch();
        refetchStatus();
        refetchDuplicates();
      } else if (res.status === 401) {
        addToast('error', 'Please sign in again to sync.');
      } else {
        addToast('error', result?.error ?? 'Sync failed.');
      }
    } catch {
      addToast('error', 'Network error during sync.');
    } finally {
      setIsSyncing(false);
    }
  }, [isSyncing, plaidStatus, refetch, refetchStatus, refetchDuplicates]);

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
        const res = await fetch('/api/bank-feed/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            transaction_id: id,
            account_id: account.id,
            vendor_id: txn?.ai_vendor?.id ?? undefined,
            job_id: txn?.final_job?.id ?? undefined,
          }),
        });
        const result = await res.json().catch(() => ({}));
        if (res.ok && result?.success) approved++;
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
  }, [transactions, refetch]);

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
      <div className="mb-4 flex items-center justify-end gap-3">
        <div className="flex items-center gap-2">
          <button
            onClick={handleSync}
            disabled={isSyncing}
            className="btn-secondary btn-sm whitespace-nowrap flex items-center gap-1.5"
            title={
              plaidStatus?.connected === false
                ? 'No bank connected yet — link an account under Integrations'
                : lastSyncedLabel
                  ? `Pull the latest transactions from your bank (last synced ${lastSyncedLabel})`
                  : 'Pull the latest transactions from your bank'
            }
          >
            <RefreshCw size={14} className={isSyncing ? 'animate-spin' : undefined} />
            {isSyncing ? 'Syncing…' : 'Refresh'}
          </button>
          <button
            onClick={() => setShowStatementImport(true)}
            className="btn-secondary btn-sm whitespace-nowrap flex items-center gap-1.5"
            title="Import a bank/credit-card statement PDF for a manual (non-Plaid) account"
          >
            <FileUp size={14} /> Import statement (PDF)
          </button>
          <button
            onClick={handleCategorizeAll}
            disabled={isCategorizing}
            className="btn-secondary btn-sm whitespace-nowrap"
            title="Run AI categorization on uncoded pending transactions"
          >
            {isCategorizing ? 'Categorizing…' : 'AI Categorize'}
          </button>
        </div>
      </div>
      {showStatementImport && (
        <StatementImport
          onClose={() => setShowStatementImport(false)}
          onImported={() => {
            setShowStatementImport(false);
            refetch();
          }}
        />
      )}
      <BankFeedFilters
        activeTab={activeTab}
        onTabChange={setActiveTab}
        search={search}
        onSearchChange={setSearch}
        counts={data?.counts ?? null}
      />
      {duplicates && duplicates.group_count > 0 && !dupBannerDismissed && (
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-4 py-3">
          <Copy size={16} className="text-amber-400 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-amber-200 font-medium">
              {duplicates.total_flagged} possible duplicate transaction{duplicates.total_flagged === 1 ? '' : 's'} across{' '}
              {duplicates.group_count} group{duplicates.group_count === 1 ? '' : 's'}
            </p>
            <p className="text-xs text-amber-200/70 mt-0.5">
              Same description and amount within a few days. Flagged for review — nothing is deleted. Look for the
              {' '}
              <span className="font-medium">Possible duplicate</span> badge below and flag or skip before approving.
            </p>
            {duplicates.groups.slice(0, 3).map((g) => (
              <p key={g.key} className="text-2xs text-amber-200/60 mt-1 font-mono truncate">
                {formatMoney(g.amountCents)} · {g.sampleDescription} · ×{g.count} ({g.dates.join(', ')})
              </p>
            ))}
          </div>
          <button
            onClick={() => setDupBannerDismissed(true)}
            className="p-1 rounded-md text-amber-300/70 hover:text-amber-200 hover:bg-amber-500/10 transition-colors shrink-0"
            aria-label="Dismiss duplicate warning"
          >
            <X size={14} />
          </button>
        </div>
      )}
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
        duplicateIds={duplicateIds}
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
