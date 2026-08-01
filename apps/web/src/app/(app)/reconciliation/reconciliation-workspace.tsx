'use client';

import { useMemo, useState } from 'react';
import {
  X,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Lock,
  Undo2,
  ArrowUpRight,
  ArrowDownLeft,
  Building2,
  ShieldCheck,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, addToast } from '@/hooks';
import { api } from '@/lib/api-client';
import { formatMoney } from '@meritbooks/shared';

// ── Types (mirror /api/reconciliation/session) ──────────────────────────────────
interface WorkspaceLine {
  id: string;
  description: string;
  amountCents: number;
  isOutflow: boolean;
  transactionDate: string;
  status: string;
  cleared: boolean;
  locked: boolean;
  glPosted: boolean;
  linkedElsewhere: boolean;
}
interface WorkspaceResponse {
  account: { id: string; accountName: string; accountMask: string; locationCode: string; locationName: string };
  period: { id: string; year: number; month: number; startDate: string; endDate: string; status: string };
  reconciliation: {
    id: string;
    statementEndingBalanceCents: number;
    glBalanceCents: number;
    isReconciled: boolean;
    reconciledAt: string | null;
    isFinalized: boolean;
  } | null;
  summary: {
    beginningBalanceCents: number;
    statementEndingBalanceCents: number | null;
    glCashBalanceCents: number;
    clearedDepositsCents: number;
    clearedPaymentsCents: number;
    clearedNetCents: number;
    clearedBalanceCents: number;
    clearedCount: number;
    unclearedCount: number;
    differenceCents: number | null;
    ties: boolean;
  };
  lines: WorkspaceLine[];
}

interface PeriodMonth {
  month: number;
  status: string;
  periodId: string | null;
}
interface PeriodGridRow {
  locationId: string;
  months: PeriodMonth[];
}
interface PeriodResponse {
  year: number;
  grid: PeriodGridRow[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dollarsToCents(v: string): number {
  const n = parseFloat(v.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function ReconciliationWorkspace({
  account,
  initialPeriodId,
  initialYear,
  onClose,
  onChanged,
}: {
  account: { id: string; accountName: string; locationId: string | null; locationCode: string };
  initialPeriodId?: string | null;
  initialYear?: number | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(initialYear ?? currentYear);
  const [periodId, setPeriodId] = useState(initialPeriodId ?? '');
  const [statement, setStatement] = useState('');
  const [statementDirty, setStatementDirty] = useState(false);
  const [busy, setBusy] = useState<null | 'start' | 'finalize' | 'unreconcile' | string>(null);

  const { data: periodData } = useQuery<PeriodResponse>('/api/periods', { year: String(year) });
  const availablePeriods = useMemo(() => {
    const row = (periodData?.grid ?? []).find((g) => g.locationId === account.locationId);
    if (!row) return [] as Array<{ periodId: string; label: string; status: string }>;
    return row.months
      .filter((m) => m.periodId && m.status !== 'HARD_CLOSE')
      .map((m) => ({ periodId: m.periodId as string, label: `${MONTHS[m.month - 1]} ${year}`, status: m.status }));
  }, [periodData, account.locationId, year]);

  const sessionUrl = periodId
    ? `/api/reconciliation/session?bank_account_id=${account.id}&fiscal_period_id=${periodId}`
    : null;
  const { data, isLoading, error, refetch } = useQuery<WorkspaceResponse>(sessionUrl);

  const rec = data?.reconciliation ?? null;
  const summary = data?.summary ?? null;
  const finalized = rec?.isFinalized ?? false;
  // Reflect the server statement balance unless the user is mid-edit.
  const statementValue =
    statementDirty || rec == null ? statement : (rec.statementEndingBalanceCents / 100).toFixed(2);

  async function startOrUpdate() {
    if (!periodId) return;
    setBusy('start');
    const result = await api.post<{ reconciliationId: string }>('/api/reconciliation/session', {
      action: 'start',
      bank_account_id: account.id,
      fiscal_period_id: periodId,
      statement_ending_balance_cents: dollarsToCents(statementValue),
    });
    setBusy(null);
    if (result.error) {
      addToast('error', result.error.error || 'Could not start reconciliation');
      return;
    }
    setStatementDirty(false);
    addToast('success', 'Statement balance saved — check off cleared lines');
    await refetch();
    onChanged();
  }

  async function toggleLine(line: WorkspaceLine) {
    if (!rec || finalized) return;
    setBusy(line.id);
    const result = await api.post<{ ok: boolean }>('/api/reconciliation/session', {
      action: 'toggle_line',
      reconciliation_id: rec.id,
      transaction_id: line.id,
      cleared: !line.cleared,
    });
    setBusy(null);
    if (result.error) {
      addToast('error', result.error.error || 'Could not update line');
      return;
    }
    await refetch();
  }

  async function finalize() {
    if (!rec) return;
    setBusy('finalize');
    const result = await api.post<{ ok: boolean }>('/api/reconciliation/session', {
      action: 'finalize',
      reconciliation_id: rec.id,
    });
    setBusy(null);
    if (result.error) {
      addToast('error', result.error.error || 'Could not finalize');
      return;
    }
    addToast('success', 'Reconciliation finalized and locked');
    await refetch();
    onChanged();
  }

  async function unreconcile() {
    if (!rec) return;
    if (!window.confirm('Undo this reconciliation? It will reopen and un-clear every line.')) return;
    setBusy('unreconcile');
    const result = await api.post<{ ok: boolean }>('/api/reconciliation/session', {
      action: 'unreconcile',
      reconciliation_id: rec.id,
    });
    setBusy(null);
    if (result.error) {
      addToast('error', result.error.error || 'Could not unreconcile');
      return;
    }
    addToast('success', 'Reconciliation reopened');
    await refetch();
    onChanged();
  }

  const diffCents = summary?.differenceCents ?? null;
  const ties = summary?.ties ?? false;
  const canFinalize = !!rec && !finalized && ties && (summary?.clearedCount ?? 0) > 0;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 z-50 flex max-h-[92vh] w-[760px] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-slate-700 bg-surface-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold text-white">
              Reconcile {account.accountName}
              {finalized && (
                <span className="inline-flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-medium text-emerald-400">
                  <Lock className="h-3 w-3" /> Locked
                </span>
              )}
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {account.locationCode} · check off statement lines until the difference is $0
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-slate-500 hover:bg-white/[0.04] hover:text-slate-200"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Period + statement inputs */}
        <div className="border-b border-slate-800 px-5 py-4">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="mb-1.5 block text-2xs font-semibold uppercase tracking-wider text-slate-500">
                Period
              </label>
              <div className="flex gap-2">
                <select
                  value={year}
                  onChange={(e) => {
                    setYear(parseInt(e.target.value, 10));
                    setPeriodId('');
                  }}
                  className="rounded-md border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-200"
                >
                  {[currentYear + 1, currentYear, currentYear - 1, currentYear - 2].map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
                <select
                  value={periodId}
                  onChange={(e) => {
                    setPeriodId(e.target.value);
                    setStatement('');
                    setStatementDirty(false);
                  }}
                  className="rounded-md border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-200"
                >
                  <option value="">Select month…</option>
                  {availablePeriods.map((p) => (
                    <option key={p.periodId} value={p.periodId}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-2xs font-semibold uppercase tracking-wider text-slate-500">
                Statement ending balance
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  disabled={!periodId || finalized}
                  value={statementValue}
                  onChange={(e) => {
                    setStatement(e.target.value);
                    setStatementDirty(true);
                  }}
                  placeholder="0.00"
                  className="w-40 rounded-md border border-slate-700 bg-slate-800/60 py-2 pl-7 pr-3 font-mono text-sm tabular-nums text-slate-200 placeholder-slate-600 focus:border-brand-500/40 focus:outline-none focus:ring-1 focus:ring-brand-500/40 disabled:opacity-50"
                />
              </div>
            </div>

            <button
              onClick={startOrUpdate}
              disabled={!periodId || finalized || busy === 'start'}
              className={clsx(
                'inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium',
                periodId && !finalized
                  ? 'bg-slate-700 text-white hover:bg-slate-600'
                  : 'cursor-not-allowed bg-slate-800 text-slate-600',
              )}
            >
              {busy === 'start' ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
              {rec ? 'Update' : 'Start'}
            </button>
          </div>
          {availablePeriods.length === 0 && (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-amber-400">
              <AlertCircle size={12} /> No open periods for this company in {year}
            </p>
          )}
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {!periodId ? (
            <div className="py-12 text-center">
              <Building2 className="mx-auto mb-3 h-9 w-9 text-slate-600" />
              <p className="text-sm text-slate-400">Select a period to begin reconciling.</p>
            </div>
          ) : isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-emerald-400" />
            </div>
          ) : error ? (
            <div className="py-12 text-center">
              <AlertCircle className="mx-auto mb-2 h-8 w-8 text-red-400" />
              <p className="text-sm text-red-400">{error}</p>
              <button
                onClick={() => refetch()}
                className="mt-3 rounded-lg bg-slate-800 px-3.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
              >
                Try again
              </button>
            </div>
          ) : data ? (
            <>
              {/* Running tie-out */}
              <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Beginning" value={formatMoney(data.summary.beginningBalanceCents)} />
                <Stat
                  label="Cleared (net)"
                  value={formatMoney(data.summary.clearedNetCents)}
                  hint={`${data.summary.clearedCount} lines`}
                />
                <Stat
                  label="Cleared balance"
                  value={formatMoney(data.summary.clearedBalanceCents)}
                  hint="beginning + cleared"
                />
                <Stat
                  label="Difference"
                  value={diffCents == null ? '—' : formatMoney(diffCents)}
                  tone={diffCents == null ? 'muted' : ties ? 'good' : 'bad'}
                  hint={
                    rec == null
                      ? 'start to compute'
                      : ties
                        ? 'ties to statement'
                        : 'to statement ending'
                  }
                />
              </div>

              {finalized && (
                <div className="mb-4 flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/[0.07] px-4 py-2.5 text-sm text-emerald-300">
                  <Lock className="h-4 w-4" />
                  Finalized {rec?.reconciledAt ? `on ${new Date(rec.reconciledAt).toLocaleDateString()}` : ''} — lines
                  are locked. Undo to make changes.
                </div>
              )}

              {/* Lines */}
              {data.lines.length === 0 ? (
                <div className="py-10 text-center">
                  <CheckCircle2 className="mx-auto mb-2 h-8 w-8 text-slate-600" />
                  <p className="text-sm text-slate-400">No statement lines in this period.</p>
                </div>
              ) : (
                <div className="overflow-hidden rounded-lg border border-slate-800">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-wider text-slate-500">
                        <th className="w-10 px-3 py-2.5"></th>
                        <th className="px-3 py-2.5">Date</th>
                        <th className="px-3 py-2.5">Description</th>
                        <th className="px-3 py-2.5 text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/40">
                      {data.lines.map((line) => {
                        const disabled = !rec || finalized || line.linkedElsewhere || busy === line.id;
                        return (
                          <tr
                            key={line.id}
                            className={clsx(
                              'transition-colors',
                              line.cleared ? 'bg-emerald-500/[0.04]' : 'hover:bg-slate-800/20',
                            )}
                          >
                            <td className="px-3 py-2.5">
                              <button
                                onClick={() => toggleLine(line)}
                                disabled={disabled}
                                aria-label={line.cleared ? 'Uncheck line' : 'Check off line'}
                                className={clsx(
                                  'flex h-5 w-5 items-center justify-center rounded border transition-colors',
                                  line.cleared
                                    ? 'border-emerald-500 bg-emerald-500/20 text-emerald-400'
                                    : 'border-slate-600 text-transparent hover:border-slate-400',
                                  disabled && 'cursor-not-allowed opacity-50',
                                )}
                              >
                                {busy === line.id ? (
                                  <Loader2 className="h-3 w-3 animate-spin text-slate-400" />
                                ) : line.locked ? (
                                  <Lock className="h-3 w-3 text-emerald-400" />
                                ) : (
                                  <CheckCircle2 className="h-3.5 w-3.5" />
                                )}
                              </button>
                            </td>
                            <td className="px-3 py-2.5 font-mono text-xs text-slate-400">{line.transactionDate}</td>
                            <td className="px-3 py-2.5">
                              <span className="flex items-center gap-2 text-slate-200">
                                {line.isOutflow ? (
                                  <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-red-400" />
                                ) : (
                                  <ArrowDownLeft className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                                )}
                                <span className="truncate">{line.description}</span>
                                {line.linkedElsewhere && (
                                  <span className="rounded bg-slate-700/50 px-1.5 py-0.5 text-[10px] text-slate-400">
                                    other rec
                                  </span>
                                )}
                              </span>
                            </td>
                            <td
                              className={clsx(
                                'px-3 py-2.5 text-right font-mono tabular-nums',
                                line.isOutflow ? 'text-red-400' : 'text-emerald-400',
                              )}
                            >
                              {formatMoney(line.amountCents)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : null}
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-between gap-2 border-t border-slate-800 px-5 py-4">
          <div className="text-xs text-slate-500">
            {summary && rec && !finalized && (
              <span>
                {summary.clearedCount} cleared · {summary.unclearedCount} outstanding
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="rounded-md px-4 py-2 text-sm text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"
            >
              Close
            </button>
            {finalized ? (
              <button
                onClick={unreconcile}
                disabled={busy === 'unreconcile'}
                className="inline-flex items-center gap-2 rounded-md border border-slate-700 bg-slate-800/40 px-4 py-2 text-sm font-medium text-slate-200 hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-300"
              >
                {busy === 'unreconcile' ? <Loader2 size={14} className="animate-spin" /> : <Undo2 size={14} />}
                Undo reconciliation
              </button>
            ) : (
              <button
                onClick={finalize}
                disabled={!canFinalize || busy === 'finalize'}
                title={canFinalize ? 'Finalize and lock' : 'Difference must be $0 with at least one cleared line'}
                className={clsx(
                  'inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium',
                  canFinalize
                    ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                    : 'cursor-not-allowed bg-slate-800 text-slate-600',
                )}
              >
                {busy === 'finalize' ? <Loader2 size={14} className="animate-spin" /> : <Lock size={14} />}
                Finalize &amp; lock
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function Stat({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'good' | 'bad' | 'muted';
}) {
  const cls =
    tone === 'good'
      ? 'text-emerald-400'
      : tone === 'bad'
        ? 'text-red-400'
        : tone === 'muted'
          ? 'text-slate-500'
          : 'text-white';
  return (
    <div className="rounded-lg bg-slate-800/40 px-3 py-2.5">
      <p className="text-[11px] uppercase tracking-wider text-slate-500">{label}</p>
      <p className={clsx('mt-1 font-mono text-base tabular-nums', cls)}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-slate-600">{hint}</p>}
    </div>
  );
}
