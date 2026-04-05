'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import { Check, Flag, Pencil, Receipt, FileText, Link2, HelpCircle, Inbox, AlertCircle, Loader2, ArrowUp, ArrowDown, Sparkles, Search, X, Briefcase, Clock } from 'lucide-react';
import { clsx } from 'clsx';
import { StatusBadge, ConfidenceBar, EmptyState, TableSkeleton } from '@/components/ui';
import { formatMoney } from '@meritbooks/shared';
import { useQuery, useDebounce } from '@/hooks';
import type { BankFeedRow, JobSearchResult } from '@meritbooks/shared';
import type { SortField, SortDir } from './bank-feed-content';

interface BankFeedListProps {
  transactions: BankFeedRow[];
  isLoading: boolean;
  error: string | null;
  onApprove: (txn: BankFeedRow) => Promise<void>;
  isApproving: boolean;
  onBatchApprove: (txnIds: string[]) => Promise<void>;
  onFlag: (txn: BankFeedRow) => void;
  onInlineUpdate: (txnId: string, updates: { final_account_id?: string; final_job_id?: string | null }) => Promise<void>;
  focusedIndex: number;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onToggleAll: () => void;
  onSelectHighConfidence: () => void;
  onSelectByVendor: (vendorName: string) => void;
  onEdit: (txn: BankFeedRow) => void;
  sortField: SortField;
  sortDir: SortDir;
  onSort: (field: SortField) => void;
  selectedLocationId: string | null;
}

// --- Match Badge ---

function MatchBadge({ txn }: { txn: BankFeedRow }) {
  const type = txn.match_type;
  if (!type || type === 'NONE') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-medium text-amber-400 bg-amber-500/10">
        <HelpCircle size={10} />
        Unmatched
      </span>
    );
  }
  const config = {
    VENDOR_PATTERN: { icon: Link2, color: 'text-slate-400 bg-slate-500/10', label: 'Vendor Match' },
    BILL_PAYMENT: { icon: FileText, color: 'text-blue-400 bg-blue-500/10', label: txn.matched_bill?.bill_number ? `Bill #${txn.matched_bill.bill_number}` : 'Bill Match' },
    RECEIPT: { icon: Receipt, color: 'text-emerald-400 bg-emerald-500/10', label: 'Receipt matched' },
  }[type] ?? { icon: Link2, color: 'text-slate-400 bg-slate-500/10', label: type };
  const Icon = config.icon;
  return (
    <span className={clsx('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-medium', config.color)}>
      <Icon size={10} />
      {config.label}
    </span>
  );
}

// --- Aging Dot (stale transaction indicator) ---

function AgingDot({ createdAt }: { createdAt: string }) {
  const hours = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60);
  if (hours < 24) return null;
  const isUrgent = hours >= 48;
  return (
    <span
      className={clsx(
        'inline-block w-1.5 h-1.5 rounded-full shrink-0',
        isUrgent ? 'bg-red-400' : 'bg-amber-400'
      )}
      title={isUrgent ? 'Pending >48h' : 'Pending >24h'}
    />
  );
}

// --- Sort Header ---

function SortHeader({ label, field, currentField, currentDir, onSort, align }: {
  label: string;
  field: SortField;
  currentField: SortField;
  currentDir: SortDir;
  onSort: (f: SortField) => void;
  align?: 'left' | 'right';
}) {
  const active = field === currentField;
  return (
    <th
      className={clsx(
        'px-3 py-3 text-2xs font-semibold uppercase tracking-wider cursor-pointer select-none transition-colors hover:text-slate-300',
        align === 'right' ? 'text-right' : 'text-left',
        active ? 'text-brand-400' : 'text-slate-500'
      )}
      onClick={() => onSort(field)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active && (currentDir === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
      </span>
    </th>
  );
}

// --- Inline Account Picker (click GL category cell to change) ---

function InlineAccountPicker({
  txn,
  vendorId,
  onSelect,
  onClose,
}: {
  txn: BankFeedRow;
  vendorId: string | undefined;
  onSelect: (accountId: string) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 200);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const searchParams: Record<string, string> = {};
  if (debouncedSearch) searchParams.q = debouncedSearch;
  if (vendorId) searchParams.vendor_id = vendorId;

  const { data } = useQuery<{ recent: Array<{ id: string; account_number: string; name: string }>; accounts: Array<{ id: string; account_number: string; name: string }> }>(
    '/api/accounts/search',
    searchParams,
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Close on click outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    }
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);

  const currentAccountId = (txn.final_account ?? txn.ai_account)?.id;

  return (
    <div ref={containerRef} className="absolute z-30 left-0 top-full mt-1 w-72 bg-surface-900 border border-slate-700 rounded-lg shadow-xl overflow-hidden">
      <div className="p-2 border-b border-slate-800">
        <div className="relative">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-600" />
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search accounts..."
            className="w-full pl-8 pr-3 py-1.5 rounded bg-slate-800/60 border border-slate-700 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-brand-500/40"
          />
        </div>
      </div>
      <div className="max-h-52 overflow-y-auto">
        {data?.recent && data.recent.length > 0 && (
          <>
            <div className="px-3 py-1 text-2xs text-slate-500 uppercase tracking-wider font-semibold bg-slate-800/60 sticky top-0">
              Vendor Recents
            </div>
            {data.recent.map((a) => (
              <button
                key={a.id}
                onClick={() => onSelect(a.id)}
                className={clsx(
                  'w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
                  a.id === currentAccountId ? 'bg-brand-500/10 text-brand-400' : 'text-slate-300 hover:bg-white/[0.04]'
                )}
              >
                <span className="font-mono text-slate-500">{a.account_number}</span>
                <span className="truncate">{a.name}</span>
                {a.id === currentAccountId && <Check size={12} className="ml-auto text-brand-400 shrink-0" />}
              </button>
            ))}
          </>
        )}
        {data?.accounts && data.accounts.length > 0 && (
          <>
            <div className="px-3 py-1 text-2xs text-slate-500 uppercase tracking-wider font-semibold bg-slate-800/60 sticky top-0">
              All Accounts
            </div>
            {data.accounts.map((a) => (
              <button
                key={a.id}
                onClick={() => onSelect(a.id)}
                className={clsx(
                  'w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
                  a.id === currentAccountId ? 'bg-brand-500/10 text-brand-400' : 'text-slate-300 hover:bg-white/[0.04]'
                )}
              >
                <span className="font-mono text-slate-500">{a.account_number}</span>
                <span className="truncate">{a.name}</span>
                {a.id === currentAccountId && <Check size={12} className="ml-auto text-brand-400 shrink-0" />}
              </button>
            ))}
          </>
        )}
        {data && data.recent.length === 0 && data.accounts.length === 0 && (
          <div className="px-3 py-4 text-xs text-slate-600 text-center">No accounts found</div>
        )}
      </div>
    </div>
  );
}

// --- Inline Job Picker ---

function InlineJobPicker({
  txn,
  locationId,
  onSelect,
  onClear,
  onClose,
}: {
  txn: BankFeedRow;
  locationId: string | null;
  onSelect: (jobId: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 200);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const effectiveLocation = locationId ?? txn.location?.id ?? null;
  const searchParams: Record<string, string> = {};
  if (effectiveLocation) searchParams.location_id = effectiveLocation;
  if (debouncedSearch) searchParams.q = debouncedSearch;

  const { data: jobs } = useQuery<JobSearchResult[]>(
    '/api/jobs/search',
    searchParams,
    { enabled: !!effectiveLocation }
  );

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    }
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);

  const currentJobId = txn.final_job?.id;

  return (
    <div ref={containerRef} className="absolute z-30 left-0 top-full mt-1 w-64 bg-surface-900 border border-slate-700 rounded-lg shadow-xl overflow-hidden">
      <div className="p-2 border-b border-slate-800">
        <div className="relative">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-600" />
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={effectiveLocation ? 'Search jobs...' : 'Select company first'}
            disabled={!effectiveLocation}
            className="w-full pl-8 pr-3 py-1.5 rounded bg-slate-800/60 border border-slate-700 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-brand-500/40 disabled:opacity-50"
          />
        </div>
      </div>
      <div className="max-h-48 overflow-y-auto">
        {/* Clear option */}
        {currentJobId && (
          <button
            onClick={onClear}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-slate-400 hover:bg-white/[0.04] border-b border-slate-800/50"
          >
            <X size={10} />
            <span>Clear job assignment</span>
          </button>
        )}
        {jobs && jobs.length > 0 ? (
          jobs.map((j) => (
            <button
              key={j.id}
              onClick={() => onSelect(j.id)}
              className={clsx(
                'w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
                j.id === currentJobId ? 'bg-brand-500/10 text-brand-400' : 'text-slate-300 hover:bg-white/[0.04]'
              )}
            >
              <span className="font-mono text-slate-500">{j.job_number}</span>
              <span className="truncate">{j.name}</span>
            </button>
          ))
        ) : (
          <div className="px-3 py-3 text-xs text-slate-600 text-center">
            {effectiveLocation ? 'No active jobs' : 'Select a company first'}
          </div>
        )}
      </div>
    </div>
  );
}

// === MAIN LIST ===

export function BankFeedList({
  transactions,
  isLoading,
  error,
  onApprove,
  isApproving,
  onBatchApprove,
  onFlag,
  onInlineUpdate,
  focusedIndex,
  selected,
  onToggleSelect,
  onToggleAll,
  onSelectHighConfidence,
  onSelectByVendor,
  onEdit,
  sortField,
  sortDir,
  onSort,
  selectedLocationId,
}: BankFeedListProps) {
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [editingAccountTxnId, setEditingAccountTxnId] = useState<string | null>(null);
  const [editingJobTxnId, setEditingJobTxnId] = useState<string | null>(null);
  const rowRefs = useRef<Map<number, HTMLTableRowElement>>(new Map());

  // Auto-scroll focused row into view
  useEffect(() => {
    if (focusedIndex >= 0) {
      const row = rowRefs.current.get(focusedIndex);
      row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [focusedIndex]);

  async function handleApproveClick(txn: BankFeedRow) {
    setApprovingId(txn.id);
    await onApprove(txn);
    setApprovingId(null);
  }

  const handleAccountSelect = useCallback(async (txnId: string, accountId: string) => {
    setEditingAccountTxnId(null);
    await onInlineUpdate(txnId, { final_account_id: accountId });
  }, [onInlineUpdate]);

  const handleJobSelect = useCallback(async (txnId: string, jobId: string) => {
    setEditingJobTxnId(null);
    await onInlineUpdate(txnId, { final_job_id: jobId });
  }, [onInlineUpdate]);

  const handleJobClear = useCallback(async (txnId: string) => {
    setEditingJobTxnId(null);
    await onInlineUpdate(txnId, { final_job_id: null });
  }, [onInlineUpdate]);

  if (isLoading) return <TableSkeleton rows={8} cols={9} />;

  if (error) {
    return (
      <div className="card p-8 text-center">
        <AlertCircle size={24} className="mx-auto text-red-400 mb-2" />
        <p className="text-sm text-red-400 font-medium mb-1">Failed to load transactions</p>
        <p className="text-xs text-slate-500">{error}</p>
      </div>
    );
  }

  if (transactions.length === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title="No transactions"
        description="No bank transactions match your current filters. Try adjusting the status tab or search terms."
      />
    );
  }

  const highConfCount = transactions.filter((t) => (t.ai_confidence ?? 0) >= 0.9 && (t.final_account ?? t.ai_account)).length;

  return (
    <div className="card overflow-hidden">
      {/* Batch action bar */}
      <div className="px-3 py-2 border-b border-slate-800/50 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {selected.size > 0 && (
            <span className="text-sm text-brand-400">{selected.size} selected</span>
          )}
          {highConfCount > 0 && (
            <button
              onClick={onSelectHighConfidence}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-2xs font-medium text-indigo-400 bg-indigo-500/10 hover:bg-indigo-500/20 transition-colors"
            >
              <Sparkles size={12} />
              Select all ≥90% ({highConfCount})
            </button>
          )}
        </div>
        {selected.size > 0 && (
          <button
            onClick={() => onBatchApprove(Array.from(selected))}
            disabled={isApproving}
            className="btn-primary btn-sm"
          >
            {isApproving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            <span>Batch Approve ({selected.size})</span>
          </button>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-800">
              <th className="w-10 px-3 py-3">
                <input
                  type="checkbox"
                  checked={selected.size === transactions.length && transactions.length > 0}
                  onChange={onToggleAll}
                  className="rounded border-slate-600 bg-transparent text-brand-500 focus:ring-brand-500/40"
                />
              </th>
              <SortHeader label="Date" field="date" currentField={sortField} currentDir={sortDir} onSort={onSort} />
              <th className="px-3 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Description</th>
              <SortHeader label="Company" field="company" currentField={sortField} currentDir={sortDir} onSort={onSort} />
              <th className="px-3 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">GL Category</th>
              <th className="px-3 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Job</th>
              <SortHeader label="Conf." field="confidence" currentField={sortField} currentDir={sortDir} onSort={onSort} />
              <SortHeader label="Amount" field="amount" currentField={sortField} currentDir={sortDir} onSort={onSort} align="right" />
              <th className="w-28 px-3 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/30">
            {transactions.map((txn, idx) => {
              const vendorLabel = txn.ai_vendor?.display_name ?? txn.ai_vendor?.name ?? null;
              const account = txn.final_account ?? txn.ai_account;
              const job = txn.final_job;
              const isCogs = account?.account_type === 'COGS' || (account?.account_number?.startsWith('5'));
              const isPosted = txn.status === 'POSTED' || txn.status === 'APPROVED';

              return (
                <tr
                  key={txn.id}
                  ref={(el) => { if (el) rowRefs.current.set(idx, el); else rowRefs.current.delete(idx); }}
                  className={clsx(
                    'table-row-hover',
                    selected.has(txn.id) && 'bg-brand-500/[0.03]',
                    focusedIndex === idx && 'ring-1 ring-inset ring-brand-500/40 bg-brand-500/[0.02]'
                  )}
                >
                  {/* Checkbox */}
                  <td className="px-3 py-2.5">
                    <input
                      type="checkbox"
                      checked={selected.has(txn.id)}
                      onChange={() => onToggleSelect(txn.id)}
                      className="rounded border-slate-600 bg-transparent text-brand-500 focus:ring-brand-500/40"
                    />
                  </td>

                  {/* Date + aging */}
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm text-slate-400 font-mono tabular-nums">{txn.transaction_date}</span>
                      {!isPosted && <AgingDot createdAt={txn.transaction_date} />}
                    </div>
                  </td>

                  {/* Description + vendor + match */}
                  <td className="px-3 py-2.5">
                    <div>
                      <p className="text-sm text-slate-200 truncate max-w-[220px]">{txn.description}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        {vendorLabel && (
                          <button
                            onClick={() => onSelectByVendor(vendorLabel)}
                            className="text-2xs text-slate-500 hover:text-brand-400 hover:underline transition-colors cursor-pointer"
                            title={`Select all ${vendorLabel} transactions`}
                          >
                            {vendorLabel}
                          </button>
                        )}
                        <MatchBadge txn={txn} />
                      </div>
                    </div>
                  </td>

                  {/* Company */}
                  <td className="px-3 py-2.5">
                    {txn.location ? (
                      <div className="flex items-center gap-1.5">
                        <span className="text-2xs font-mono text-slate-500 bg-slate-800 px-1 py-0.5 rounded">
                          {txn.location.short_code}
                        </span>
                        <span className="text-sm text-slate-300 truncate max-w-[100px]">{txn.location.name}</span>
                      </div>
                    ) : (
                      <span className="text-sm text-slate-600">--</span>
                    )}
                  </td>

                  {/* GL Category — INLINE EDITABLE */}
                  <td className="px-3 py-2.5 relative">
                    {isPosted ? (
                      <span className="text-xs font-mono text-slate-400">
                        {account ? `${account.account_number} · ${account.name}` : '--'}
                      </span>
                    ) : (
                      <button
                        onClick={() => setEditingAccountTxnId(editingAccountTxnId === txn.id ? null : txn.id)}
                        className={clsx(
                          'text-left text-xs font-mono px-2 py-1 rounded transition-colors w-full truncate max-w-[180px]',
                          account
                            ? 'text-slate-300 hover:bg-white/[0.04] hover:text-white'
                            : 'text-amber-400 italic hover:bg-amber-500/10'
                        )}
                        title="Click to change GL account"
                      >
                        {account ? `${account.account_number} · ${account.name}` : 'Assign account...'}
                      </button>
                    )}
                    {editingAccountTxnId === txn.id && (
                      <InlineAccountPicker
                        txn={txn}
                        vendorId={txn.ai_vendor?.id}
                        onSelect={(accountId) => handleAccountSelect(txn.id, accountId)}
                        onClose={() => setEditingAccountTxnId(null)}
                      />
                    )}
                  </td>

                  {/* Job — INLINE EDITABLE */}
                  <td className="px-3 py-2.5 relative">
                    {isPosted ? (
                      <span className="text-xs text-slate-400">
                        {job ? `${job.job_number} · ${job.name}` : '--'}
                      </span>
                    ) : (
                      <button
                        onClick={() => setEditingJobTxnId(editingJobTxnId === txn.id ? null : txn.id)}
                        className={clsx(
                          'text-left text-xs px-2 py-1 rounded transition-colors w-full truncate max-w-[140px]',
                          job
                            ? 'text-slate-300 hover:bg-white/[0.04]'
                            : isCogs
                              ? 'text-red-400 italic hover:bg-red-500/10'
                              : 'text-slate-600 hover:bg-white/[0.04]'
                        )}
                        title={isCogs ? 'COGS account — job required' : 'Click to assign job (optional)'}
                      >
                        {job ? `${job.job_number} · ${job.name}` : isCogs ? 'Required...' : '—'}
                      </button>
                    )}
                    {editingJobTxnId === txn.id && (
                      <InlineJobPicker
                        txn={txn}
                        locationId={selectedLocationId}
                        onSelect={(jobId) => handleJobSelect(txn.id, jobId)}
                        onClear={() => handleJobClear(txn.id)}
                        onClose={() => setEditingJobTxnId(null)}
                      />
                    )}
                  </td>

                  {/* Confidence */}
                  <td className="px-3 py-2.5">
                    {txn.ai_confidence != null ? (
                      <ConfidenceBar value={txn.ai_confidence} />
                    ) : (
                      <span className="text-2xs text-slate-600">—</span>
                    )}
                  </td>

                  {/* Amount */}
                  <td className="px-3 py-2.5 text-right">
                    <span className={clsx(
                      'text-sm font-mono tabular-nums font-medium',
                      txn.amount_cents >= 0 ? 'text-emerald-400' : 'text-slate-200'
                    )}>
                      {formatMoney(txn.amount_cents)}
                    </span>
                  </td>

                  {/* Actions */}
                  <td className="px-3 py-2.5">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => handleApproveClick(txn)}
                        disabled={!account || approvingId === txn.id || isPosted || (isCogs && !job)}
                        className={clsx(
                          'p-1.5 rounded-md transition-colors',
                          !account || isPosted || (isCogs && !job)
                            ? 'text-slate-700 cursor-not-allowed'
                            : 'text-slate-500 hover:text-emerald-400 hover:bg-emerald-500/10'
                        )}
                        title={isCogs && !job ? 'Assign job before approving (COGS)' : 'Approve (a)'}
                      >
                        {approvingId === txn.id
                          ? <Loader2 size={14} className="animate-spin" />
                          : <Check size={14} />}
                      </button>
                      <button
                        onClick={() => onEdit(txn)}
                        className="p-1.5 rounded-md text-slate-500 hover:text-slate-200 hover:bg-white/[0.04] transition-colors"
                        title="Full edit panel (e)"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        onClick={() => onFlag(txn)}
                        disabled={isPosted || txn.status === 'FLAGGED'}
                        className={clsx(
                          'p-1.5 rounded-md transition-colors',
                          isPosted || txn.status === 'FLAGGED'
                            ? 'text-slate-700 cursor-not-allowed'
                            : 'text-slate-500 hover:text-amber-400 hover:bg-amber-500/10'
                        )}
                        title="Flag for review (f)"
                      >
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

      {/* Keyboard shortcuts hint */}
      <div className="px-3 py-2 border-t border-slate-800/50 flex items-center gap-4 text-2xs text-slate-600">
        <span><kbd className="px-1 py-0.5 rounded bg-slate-800 text-slate-500 font-mono">j</kbd>/<kbd className="px-1 py-0.5 rounded bg-slate-800 text-slate-500 font-mono">k</kbd> navigate</span>
        <span><kbd className="px-1 py-0.5 rounded bg-slate-800 text-slate-500 font-mono">a</kbd> approve</span>
        <span><kbd className="px-1 py-0.5 rounded bg-slate-800 text-slate-500 font-mono">e</kbd> edit</span>
        <span><kbd className="px-1 py-0.5 rounded bg-slate-800 text-slate-500 font-mono">f</kbd> flag</span>
        <span><kbd className="px-1 py-0.5 rounded bg-slate-800 text-slate-500 font-mono">space</kbd> select</span>
        <span><kbd className="px-1 py-0.5 rounded bg-slate-800 text-slate-500 font-mono">esc</kbd> clear</span>
      </div>
    </div>
  );
}
