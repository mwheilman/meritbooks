'use client';

import { useRef, useEffect, useState } from 'react';
import { Check, Flag, Pencil, Receipt, FileText, Link2, HelpCircle, Inbox, AlertCircle, Loader2, ArrowUp, ArrowDown, Sparkles } from 'lucide-react';
import { clsx } from 'clsx';
import { StatusBadge, ConfidenceBar, EmptyState, TableSkeleton } from '@/components/ui';
import { formatMoney } from '@meritbooks/shared';
import type { BankFeedRow } from '@meritbooks/shared';
import type { SortField, SortDir } from './bank-feed-content';

interface BankFeedListProps {
  transactions: BankFeedRow[];
  isLoading: boolean;
  error: string | null;
  onApprove: (txn: BankFeedRow) => Promise<void>;
  isApproving: boolean;
  onBatchApprove: (txnIds: string[]) => Promise<void>;
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
}

function MatchBadge({ txn }: { txn: BankFeedRow }) {
  const type = txn.match_type;

  // Unmatched: no match type, or explicitly NONE
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
        'px-4 py-3 text-2xs font-semibold uppercase tracking-wider cursor-pointer select-none transition-colors hover:text-slate-300',
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

export function BankFeedList({
  transactions,
  isLoading,
  error,
  onApprove,
  isApproving,
  onBatchApprove,
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
}: BankFeedListProps) {
  const [approvingId, setApprovingId] = useState<string | null>(null);
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

  // Loading state
  if (isLoading) {
    return <TableSkeleton rows={8} cols={7} />;
  }

  // Error state
  if (error) {
    return (
      <div className="card p-8 text-center">
        <AlertCircle size={24} className="mx-auto text-red-400 mb-2" />
        <p className="text-sm text-red-400 font-medium mb-1">Failed to load transactions</p>
        <p className="text-xs text-slate-500">{error}</p>
      </div>
    );
  }

  // Empty state
  if (transactions.length === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title="No transactions"
        description="No bank transactions match your current filters. Try adjusting the status tab or search terms."
      />
    );
  }

  const highConfCount = transactions.filter((t) => (t.ai_confidence ?? 0) >= 0.9 && t.ai_account).length;

  return (
    <div className="card overflow-hidden">
      {/* Batch action bar */}
      <div className="px-4 py-2 border-b border-slate-800/50 flex items-center justify-between">
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
              Select all {'\u2265'}90% ({highConfCount})
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

      <table className="w-full">
        <thead>
          <tr className="border-b border-slate-800">
            <th className="w-10 px-4 py-3">
              <input
                type="checkbox"
                checked={selected.size === transactions.length && transactions.length > 0}
                onChange={onToggleAll}
                className="rounded border-slate-600 bg-transparent text-brand-500 focus:ring-brand-500/40"
              />
            </th>
            <SortHeader label="Date" field="date" currentField={sortField} currentDir={sortDir} onSort={onSort} />
            <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Description</th>
            <SortHeader label="Company" field="company" currentField={sortField} currentDir={sortDir} onSort={onSort} />
            <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">AI Category</th>
            <SortHeader label="Confidence" field="confidence" currentField={sortField} currentDir={sortDir} onSort={onSort} />
            <SortHeader label="Amount" field="amount" currentField={sortField} currentDir={sortDir} onSort={onSort} align="right" />
            <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Status</th>
            <th className="w-28 px-4 py-3"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/30">
          {transactions.map((txn, idx) => {
            const vendorLabel = txn.ai_vendor?.display_name ?? txn.ai_vendor?.name ?? null;
            return (
              <tr
                key={txn.id}
                ref={(el) => {
                  if (el) rowRefs.current.set(idx, el);
                  else rowRefs.current.delete(idx);
                }}
                className={clsx(
                  'table-row-hover',
                  selected.has(txn.id) && 'bg-brand-500/[0.03]',
                  focusedIndex === idx && 'ring-1 ring-inset ring-brand-500/40 bg-brand-500/[0.02]'
                )}
              >
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    checked={selected.has(txn.id)}
                    onChange={() => onToggleSelect(txn.id)}
                    className="rounded border-slate-600 bg-transparent text-brand-500 focus:ring-brand-500/40"
                  />
                </td>
                <td className="px-4 py-3 text-sm text-slate-400 font-mono tabular-nums whitespace-nowrap">
                  {txn.transaction_date}
                </td>
                <td className="px-4 py-3">
                  <div>
                    <p className="text-sm text-slate-200 truncate max-w-xs">{txn.description}</p>
                    {vendorLabel && (
                      <button
                        onClick={() => onSelectByVendor(vendorLabel)}
                        className="text-2xs text-slate-500 mt-0.5 hover:text-brand-400 hover:underline transition-colors cursor-pointer"
                        title={`Select all ${vendorLabel} transactions`}
                      >
                        {vendorLabel}
                      </button>
                    )}
                    <MatchBadge txn={txn} />
                  </div>
                </td>
                <td className="px-4 py-3">
                  {txn.location ? (
                    <div className="flex items-center gap-2">
                      <div className="h-5 w-5 rounded bg-slate-800 flex items-center justify-center text-2xs font-bold text-slate-500">
                        {txn.location.short_code.slice(0, 2)}
                      </div>
                      <span className="text-sm text-slate-300 truncate max-w-[140px]">{txn.location.name}</span>
                    </div>
                  ) : (
                    <span className="text-sm text-slate-600">--</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {txn.ai_account ? (
                    <span className="text-sm text-slate-300 font-mono text-xs">
                      {txn.ai_account.account_number} · {txn.ai_account.name}
                    </span>
                  ) : (
                    <span className="text-sm text-slate-600 italic">Uncategorized</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {txn.ai_confidence != null ? (
                    <ConfidenceBar value={txn.ai_confidence} />
                  ) : (
                    <span className="text-2xs text-slate-600">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <span className={clsx(
                    'text-sm font-mono tabular-nums font-medium',
                    txn.amount_cents >= 0 ? 'text-emerald-400' : 'text-slate-200'
                  )}>
                    {formatMoney(txn.amount_cents)}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={txn.status} />
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    <button
                      onClick={() => handleApproveClick(txn)}
                      disabled={!txn.ai_account || approvingId === txn.id || txn.status === 'POSTED' || txn.status === 'APPROVED'}
                      className={clsx(
                        'p-1.5 rounded-md transition-colors',
                        !txn.ai_account || txn.status === 'POSTED' || txn.status === 'APPROVED'
                          ? 'text-slate-700 cursor-not-allowed'
                          : 'text-slate-500 hover:text-emerald-400 hover:bg-emerald-500/10'
                      )}
                      title="Approve (a)"
                    >
                      {approvingId === txn.id
                        ? <Loader2 size={14} className="animate-spin" />
                        : <Check size={14} />}
                    </button>
                    <button
                      onClick={() => onEdit(txn)}
                      className="p-1.5 rounded-md text-slate-500 hover:text-slate-200 hover:bg-white/[0.04] transition-colors"
                      title="Edit (e)"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      className="p-1.5 rounded-md text-slate-500 hover:text-amber-400 hover:bg-amber-500/10 transition-colors"
                      title="Flag (f)"
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

      {/* Keyboard shortcuts hint */}
      <div className="px-4 py-2 border-t border-slate-800/50 flex items-center gap-4 text-2xs text-slate-600">
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
