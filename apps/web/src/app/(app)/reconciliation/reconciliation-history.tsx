'use client';

import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import {
  X,
  Loader2,
  AlertCircle,
  History,
  Lock,
  ChevronLeft,
  ArrowUpRight,
  ArrowDownLeft,
  CheckCircle2,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { formatMoney } from '@meritbooks/shared';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface HistoryRow {
  id: string;
  periodYear: number | null;
  periodMonth: number | null;
  statementDate: string;
  statementEndingBalanceCents: number;
  glBalanceCents: number;
  clearedCount: number;
  clearedNetCents: number;
  reconciledAt: string | null;
  reconciledByName: string | null;
}
interface HistoryListResponse {
  reconciliations: HistoryRow[];
}

interface DetailLine {
  id: string;
  description: string;
  amountCents: number;
  isOutflow: boolean;
  transactionDate: string;
  status: string;
}
interface DetailResponse {
  reconciliation: {
    id: string;
    periodYear: number | null;
    periodMonth: number | null;
    statementDate: string;
    statementEndingBalanceCents: number;
    glBalanceCents: number;
    reconciledAt: string | null;
    reconciledByName: string | null;
    clearedCount: number;
    clearedDepositsCents: number;
    clearedPaymentsCents: number;
    clearedNetCents: number;
  };
  lines: DetailLine[];
}

function periodLabel(year: number | null, month: number | null): string {
  if (!year || !month) return '—';
  return `${MONTHS[month - 1] ?? '??'} ${year}`;
}

/**
 * Read-only reconciliation history for one bank account: a list of prior finalized
 * reconciliations (statement/book balances, cleared total, who locked it + when),
 * with drill-in to a period's locked lines. Writes nothing.
 */
export function ReconciliationHistory({
  bankAccountId,
  accountName,
  onClose,
}: {
  bankAccountId: string;
  accountName: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (selected) setSelected(null);
      else onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selected, onClose]);

  async function loadList() {
    setListError(null);
    const res = await api.get<HistoryListResponse>('/api/reconciliation/history', { bank_account_id: bankAccountId });
    if (res.error) {
      setListError(res.error.error || 'Could not load reconciliation history');
      setRows([]);
      return;
    }
    setRows(res.data?.reconciliations ?? []);
  }

  useEffect(() => {
    void loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bankAccountId]);

  async function openDetail(id: string) {
    setSelected(id);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    const res = await api.get<DetailResponse>('/api/reconciliation/history', { reconciliation_id: id });
    setDetailLoading(false);
    if (res.error) {
      setDetailError(res.error.error || 'Could not load this reconciliation');
      return;
    }
    setDetail(res.data ?? null);
  }

  return (
    <>
      <div className="fixed inset-0 z-[60] bg-black/50" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Reconciliation history for ${accountName}`}
        className="fixed left-1/2 top-1/2 z-[70] flex max-h-[88vh] w-[720px] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-slate-700 bg-surface-900 shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <div className="flex items-center gap-2">
            {selected && (
              <button
                onClick={() => setSelected(null)}
                className="rounded-md p-1 text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"
                aria-label="Back to history list"
              >
                <ChevronLeft size={18} />
              </button>
            )}
            <div>
              <h3 className="flex items-center gap-2 text-base font-semibold text-white">
                <History size={16} className="text-indigo-400" />
                {selected ? 'Reconciliation detail' : 'Reconciliation history'}
              </h3>
              <p className="mt-0.5 text-xs text-slate-500">{accountName} · read-only</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-slate-500 hover:bg-white/[0.04] hover:text-slate-200"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {selected ? (
            <DetailView loading={detailLoading} error={detailError} detail={detail} onRetry={() => openDetail(selected)} />
          ) : rows == null ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-indigo-400" />
            </div>
          ) : listError ? (
            <div className="py-12 text-center">
              <AlertCircle className="mx-auto mb-2 h-8 w-8 text-red-400" />
              <p className="text-sm text-red-400">{listError}</p>
              <button
                onClick={() => void loadList()}
                className="mt-3 rounded-lg bg-slate-800 px-3.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
              >
                Try again
              </button>
            </div>
          ) : rows.length === 0 ? (
            <div className="py-12 text-center">
              <History className="mx-auto mb-2 h-9 w-9 text-slate-600" />
              <p className="text-sm text-slate-400">No finalized reconciliations yet.</p>
              <p className="mt-1 text-xs text-slate-500">
                Finalized reconciliations for this account will appear here.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-800 text-left text-[10px] uppercase tracking-wider text-slate-500">
                    <th className="px-3 py-2">Period</th>
                    <th className="px-3 py-2">Statement date</th>
                    <th className="px-3 py-2 text-right">Statement</th>
                    <th className="px-3 py-2 text-right">Book (GL)</th>
                    <th className="px-3 py-2 text-right">Cleared</th>
                    <th className="px-3 py-2">Locked by</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/40">
                  {rows.map((r) => (
                    <tr
                      key={r.id}
                      onClick={() => openDetail(r.id)}
                      className="cursor-pointer hover:bg-slate-800/20"
                    >
                      <td className="px-3 py-2.5 text-white">{periodLabel(r.periodYear, r.periodMonth)}</td>
                      <td className="px-3 py-2.5 font-mono text-xs text-slate-400">{r.statementDate}</td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-300">
                        {formatMoney(r.statementEndingBalanceCents)}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-300">
                        {formatMoney(r.glBalanceCents)}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <span className="font-mono tabular-nums text-slate-300">{formatMoney(r.clearedNetCents)}</span>
                        <span className="ml-1 text-2xs text-slate-600">{r.clearedCount} ln</span>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="flex items-center gap-1 text-xs text-slate-300">
                          <Lock className="h-3 w-3 text-emerald-400" />
                          <span className="truncate">{r.reconciledByName ?? 'Unknown'}</span>
                        </span>
                        {r.reconciledAt && (
                          <span className="text-2xs text-slate-600">
                            {new Date(r.reconciledAt).toLocaleDateString()}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end border-t border-slate-800 px-5 py-4">
          <button
            onClick={onClose}
            className="rounded-md px-4 py-2 text-sm text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"
          >
            Close
          </button>
        </div>
      </div>
    </>
  );
}

function DetailView({
  loading,
  error,
  detail,
  onRetry,
}: {
  loading: boolean;
  error: string | null;
  detail: DetailResponse | null;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-indigo-400" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="py-12 text-center">
        <AlertCircle className="mx-auto mb-2 h-8 w-8 text-red-400" />
        <p className="text-sm text-red-400">{error}</p>
        <button
          onClick={onRetry}
          className="mt-3 rounded-lg bg-slate-800 px-3.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
        >
          Try again
        </button>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="py-12 text-center">
        <CheckCircle2 className="mx-auto mb-2 h-8 w-8 text-slate-600" />
        <p className="text-sm text-slate-400">Nothing to show.</p>
      </div>
    );
  }

  const r = detail.reconciliation;
  return (
    <>
      <div className="mb-4 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.05] px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium text-white">
          <Lock className="h-4 w-4 text-emerald-400" />
          {periodLabel(r.periodYear, r.periodMonth)} · finalized
          {r.reconciledAt ? ` ${new Date(r.reconciledAt).toLocaleDateString()}` : ''}
          {r.reconciledByName ? ` by ${r.reconciledByName}` : ''}
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MiniStat label="Statement" value={formatMoney(r.statementEndingBalanceCents)} />
        <MiniStat label="Book (GL)" value={formatMoney(r.glBalanceCents)} />
        <MiniStat label="Cleared (net)" value={formatMoney(r.clearedNetCents)} hint={`${r.clearedCount} lines`} />
        <MiniStat
          label="Deposits / Payments"
          value={`${formatMoney(r.clearedDepositsCents)} / ${formatMoney(-r.clearedPaymentsCents)}`}
        />
      </div>

      {detail.lines.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-500">No lines were cleared into this reconciliation.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-left text-[10px] uppercase tracking-wider text-slate-500">
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Description</th>
                <th className="px-3 py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/40">
              {detail.lines.map((l) => (
                <tr key={l.id} className="hover:bg-slate-800/20">
                  <td className="px-3 py-2 font-mono text-xs text-slate-400">{l.transactionDate}</td>
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-2 text-slate-200">
                      {l.isOutflow ? (
                        <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-red-400" />
                      ) : (
                        <ArrowDownLeft className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                      )}
                      <span className="truncate">{l.description}</span>
                    </span>
                  </td>
                  <td
                    className={clsx(
                      'px-3 py-2 text-right font-mono tabular-nums',
                      l.isOutflow ? 'text-red-400' : 'text-emerald-400',
                    )}
                  >
                    {formatMoney(l.amountCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function MiniStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md bg-slate-800/40 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-0.5 font-mono text-sm tabular-nums text-slate-200">{value}</p>
      {hint && <p className="mt-0.5 text-[10px] text-slate-600">{hint}</p>}
    </div>
  );
}
