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
  Plus,
  Receipt,
  Sparkles,
  Check,
  Ban,
  AlertTriangle,
  FileText,
  Clock,
  ShieldAlert,
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
interface StaleItemDto {
  id: string;
  description: string;
  amountCents: number;
  transactionDate: string;
  ageDays: number;
  isOutflow: boolean;
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
    overridden: boolean;
    overrideReason: string | null;
  } | null;
  capabilities: { overrideAvailable: boolean };
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
    plugCents: number | null;
    hasPlug: boolean;
  };
  plug: { plugCents: number; hasPlug: boolean; ties: boolean } | null;
  staleSummary: {
    thresholdDays: number;
    count: number;
    outstandingChecksCents: number;
    depositsInTransitCents: number;
    netCents: number;
  };
  staleItems: StaleItemDto[];
  lines: WorkspaceLine[];
}

interface MemoResponse {
  memo: string;
  summary: {
    differenceCents: number;
    ties: boolean;
    plugCents: number;
    clearedCount: number;
    outstandingCount: number;
    staleCount: number;
    finalized: boolean;
    overridden: boolean;
  };
  staleItems: StaleItemDto[];
  meta: { source: string; model: string | null; message?: string };
}

interface AccountOption {
  id: string;
  account_number: string;
  name: string;
  account_type: string;
}
interface AccountsResponse {
  recent: AccountOption[];
  accounts: AccountOption[];
}

type AdjustmentType = 'bank_fee' | 'interest' | 'other';

interface AdjustmentProposalDto {
  sourceTransactionId: string;
  category: 'bank_fee' | 'interest' | 'nsf' | 'fx_rounding';
  adjustmentType: AdjustmentType;
  cashEffect: 'increase' | 'decrease';
  amountCents: number;
  offsetAccountId: string | null;
  needsOffsetAccount: boolean;
  suggestedMemo: string;
  confidence: number;
  reasoning: string;
}
interface SuggestResponse {
  reconciliationId: string;
  finalized: boolean;
  differenceCents: number;
  ties: boolean;
  unexplainedVarianceCents: number;
  unexplainedLineCount: number;
  proposals: AdjustmentProposalDto[];
}

const CATEGORY_LABEL: Record<AdjustmentProposalDto['category'], string> = {
  bank_fee: 'Bank fee',
  interest: 'Interest income',
  nsf: 'NSF / returned item',
  fx_rounding: 'FX / rounding',
};

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

/** A v4-shaped uuid for the adjustment idempotency key (schema requires uuid). */
function newUuid(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
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

  // ── Override (must-tie gate) + memo state (Wave B) ────────────────────────────
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [memoOpen, setMemoOpen] = useState(false);
  const [memoLoading, setMemoLoading] = useState(false);
  const [memoError, setMemoError] = useState<string | null>(null);
  const [memo, setMemo] = useState<MemoResponse | null>(null);

  // ── Adjusting-entry (bank fee / interest / other) state ───────────────────────
  const [showAdjust, setShowAdjust] = useState(false);
  const [adjType, setAdjType] = useState<AdjustmentType>('bank_fee');
  const [adjAmount, setAdjAmount] = useState('');
  const [adjDate, setAdjDate] = useState('');
  const [adjMemo, setAdjMemo] = useState('');
  const [adjOffsetId, setAdjOffsetId] = useState('');
  const [adjCashEffect, setAdjCashEffect] = useState<'increase' | 'decrease'>('decrease');
  // When the form was opened from an AI proposal, the feed line it books in place.
  const [adjSourceTxnId, setAdjSourceTxnId] = useState<string | null>(null);
  // Stable per form-open so a double-submit is one idempotent no-op, not two entries.
  const [adjKey, setAdjKey] = useState('');

  // ── AI-drafted adjusting-entry proposals (feature RECON_ADJUSTMENT) ────────────
  const suggestUrl = rec && !finalized ? `/api/reconciliation/adjustment/suggest?reconciliation_id=${rec.id}` : null;
  const { data: suggestData, refetch: refetchSuggest } = useQuery<SuggestResponse>(suggestUrl);
  const [rejectedIds, setRejectedIds] = useState<Set<string>>(new Set());
  const [busyProposal, setBusyProposal] = useState<string | null>(null);
  const proposals = (suggestData?.proposals ?? []).filter((p) => !rejectedIds.has(p.sourceTransactionId));
  const unexplainedCents = suggestData?.unexplainedVarianceCents ?? 0;
  const hasUnexplained = !!suggestData && !suggestData.ties;

  // Load the chart once the form is open (offset-account picker for interest/other).
  const { data: accountsData } = useQuery<AccountsResponse>(showAdjust ? '/api/accounts/search' : null);
  const offsetOptions = useMemo(() => {
    const all = [...(accountsData?.recent ?? []), ...(accountsData?.accounts ?? [])];
    if (adjType === 'interest') {
      return all.filter((a) => a.account_type === 'REVENUE' || a.account_type === 'OTHER');
    }
    return all;
  }, [accountsData, adjType]);

  function openAdjust() {
    setAdjType('bank_fee');
    setAdjAmount('');
    setAdjDate(data?.period.endDate ?? '');
    setAdjMemo('');
    setAdjOffsetId('');
    setAdjCashEffect('decrease');
    setAdjSourceTxnId(null);
    setAdjKey(newUuid());
    setShowAdjust(true);
  }

  // Approve an AI proposal. When the offset account is resolved we post straight
  // through the vetted adjustment route (attaching to the source feed line so the
  // rec ties without a duplicate row); when it isn't (e.g. which income account for
  // interest), we pre-fill the form so the human picks it — never auto-posted.
  async function approveProposal(p: AdjustmentProposalDto) {
    if (!rec) return;
    if (p.needsOffsetAccount) {
      setAdjType(p.adjustmentType);
      setAdjAmount((p.amountCents / 100).toFixed(2));
      setAdjDate(data?.period.endDate ?? '');
      setAdjMemo(p.suggestedMemo);
      setAdjOffsetId(p.offsetAccountId ?? '');
      setAdjCashEffect(p.cashEffect);
      setAdjSourceTxnId(p.sourceTransactionId);
      setAdjKey(newUuid());
      setShowAdjust(true);
      addToast('success', 'Choose the offsetting account, then post');
      return;
    }
    setBusyProposal(p.sourceTransactionId);
    const result = await api.post<{ ok: boolean }>('/api/reconciliation/adjustment', {
      reconciliation_id: rec.id,
      adjustment_type: p.adjustmentType,
      amount_cents: p.amountCents,
      entry_date: data?.period.endDate,
      memo: p.suggestedMemo,
      offset_account_id: p.adjustmentType === 'bank_fee' ? undefined : p.offsetAccountId ?? undefined,
      cash_effect: p.adjustmentType === 'other' ? p.cashEffect : undefined,
      source_transaction_id: p.sourceTransactionId,
      idempotency_key: newUuid(),
    });
    setBusyProposal(null);
    if (result.error) {
      addToast('error', result.error.error || 'Could not post the suggested adjustment');
      return;
    }
    addToast('success', 'Suggested adjustment posted and cleared');
    await refetch();
    await refetchSuggest();
    onChanged();
  }

  function rejectProposal(id: string) {
    setRejectedIds((prev) => new Set(prev).add(id));
  }

  async function submitAdjustment() {
    if (!rec) return;
    const amountCents = dollarsToCents(adjAmount);
    if (amountCents <= 0) {
      addToast('error', 'Enter an amount greater than $0');
      return;
    }
    if (!adjMemo.trim()) {
      addToast('error', 'Add a memo describing the adjustment');
      return;
    }
    if (adjType !== 'bank_fee' && !adjOffsetId) {
      addToast('error', 'Choose the offsetting GL account');
      return;
    }
    setBusy('adjust');
    const result = await api.post<{ ok: boolean }>('/api/reconciliation/adjustment', {
      reconciliation_id: rec.id,
      adjustment_type: adjType,
      amount_cents: amountCents,
      entry_date: adjDate || data?.period.endDate,
      memo: adjMemo.trim(),
      offset_account_id: adjType === 'bank_fee' ? undefined : adjOffsetId,
      cash_effect: adjType === 'other' ? adjCashEffect : undefined,
      source_transaction_id: adjSourceTxnId ?? undefined,
      idempotency_key: adjKey || newUuid(),
    });
    setBusy(null);
    if (result.error) {
      addToast('error', result.error.error || 'Could not post adjustment');
      return;
    }
    addToast('success', 'Adjusting entry posted and cleared');
    setShowAdjust(false);
    await refetch();
    await refetchSuggest();
    onChanged();
  }
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
    await refetchSuggest();
  }

  async function finalize(override?: { reason: string }) {
    if (!rec) return;
    setBusy('finalize');
    const result = await api.post<{ ok: boolean; override?: boolean }>('/api/reconciliation/session', {
      action: 'finalize',
      reconciliation_id: rec.id,
      ...(override ? { override: true, override_reason: override.reason } : {}),
    });
    setBusy(null);
    if (result.error) {
      addToast('error', result.error.error || 'Could not finalize');
      return;
    }
    addToast('success', override ? 'Finalized with authorized override' : 'Reconciliation finalized and locked');
    setOverrideOpen(false);
    setOverrideReason('');
    await refetch();
    onChanged();
  }

  async function submitOverride() {
    const reason = overrideReason.trim();
    if (reason.length < 8) {
      addToast('error', 'Enter an override reason of at least 8 characters');
      return;
    }
    await finalize({ reason });
  }

  async function loadMemo() {
    if (!rec) return;
    setMemoOpen(true);
    setMemoLoading(true);
    setMemoError(null);
    const result = await api.get<MemoResponse>(`/api/reconciliation/memo?reconciliation_id=${rec.id}`);
    setMemoLoading(false);
    if (result.error) {
      setMemoError(result.error.error || 'Could not draft the memo');
      return;
    }
    setMemo(result.data ?? null);
  }

  async function copyMemo() {
    if (!memo?.memo) return;
    try {
      await navigator.clipboard.writeText(memo.memo);
      addToast('success', 'Memo copied to clipboard');
    } catch {
      addToast('error', 'Could not copy the memo');
    }
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

              {finalized && rec?.overridden && (
                <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.07] px-4 py-2.5 text-sm">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                  <div>
                    <p className="font-medium text-amber-100">Finalized with authorized override</p>
                    <p className="mt-0.5 text-xs text-amber-300/80">
                      A non-zero difference was accepted (not posted).
                      {rec.overrideReason ? ` Reason: ${rec.overrideReason}` : ''}
                    </p>
                  </div>
                </div>
              )}

              {/* Unexplained variance — surfaced, never plugged (canon §3) */}
              {rec && !finalized && hasUnexplained && (
                <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.07] px-4 py-2.5 text-sm text-amber-200">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                  <div>
                    <p className="font-medium text-amber-100">
                      Unexplained variance {formatMoney(unexplainedCents)}
                    </p>
                    <p className="mt-0.5 text-xs text-amber-300/80">
                      {proposals.length > 0
                        ? 'Review the suggested adjustments below, or check off outstanding lines. Do not force it to $0 — an unexplained difference must be investigated, never plugged.'
                        : `${suggestData?.unexplainedLineCount ?? 0} unmatched line(s) with no auto-drafted cause. Investigate — the rec must tie legitimately, not by a plug.`}
                    </p>
                  </div>
                </div>
              )}

              {/* Stale reconciling items — aged, never-cleared items to investigate */}
              {data.staleItems.length > 0 && (
                <div className="mb-4 rounded-lg border border-amber-500/25 bg-amber-500/[0.05] p-4">
                  <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-white">
                    <Clock size={14} className="text-amber-400" />
                    Stale reconciling items
                    <span className="ml-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                      {data.staleSummary.count}
                    </span>
                    <span className="ml-auto text-2xs font-normal text-slate-500">
                      older than {data.staleSummary.thresholdDays} days · investigate, do not force
                    </span>
                  </div>
                  <ul className="divide-y divide-amber-500/10">
                    {data.staleItems.map((s) => (
                      <li key={s.id} className="flex items-center justify-between gap-3 py-1.5">
                        <div className="min-w-0">
                          <span className="truncate text-sm text-slate-200">{s.description}</span>
                          <span className="ml-2 font-mono text-2xs text-slate-500">{s.transactionDate}</span>
                        </div>
                        <div className="flex shrink-0 items-center gap-3">
                          <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-2xs font-medium text-amber-300">
                            {s.ageDays}d old
                          </span>
                          <span
                            className={clsx(
                              'font-mono text-sm tabular-nums',
                              s.isOutflow ? 'text-red-400' : 'text-emerald-400',
                            )}
                          >
                            {formatMoney(s.amountCents)}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* The plug — unexplained residual surfaced, NEVER auto-posted (canon §3) */}
              {rec && !finalized && summary?.hasPlug && (
                <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/[0.06] px-4 py-2.5 text-sm">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                  <div>
                    <p className="font-medium text-red-200">
                      Unexplained difference (plug) {formatMoney(summary.plugCents ?? 0)}
                    </p>
                    <p className="mt-0.5 text-xs text-red-300/80">
                      This residual is shown for investigation only — it is never posted. Clear the remaining lines or
                      book a legitimate adjustment to tie to $0. An authorized override is required to finalize with a
                      plug outstanding.
                    </p>
                  </div>
                </div>
              )}

              {/* Authorized override of the must-tie gate — reason required */}
              {rec && !finalized && overrideOpen && (
                <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-4">
                  <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-white">
                    <ShieldAlert size={14} className="text-amber-400" /> Override the tie-out gate
                  </div>
                  {data.capabilities.overrideAvailable ? (
                    <>
                      <p className="mb-2 text-xs text-amber-300/80">
                        Finalizing with an unexplained difference of{' '}
                        <span className="font-mono">{formatMoney(summary?.plugCents ?? 0)}</span> requires approval
                        authority and a recorded reason. The plug is documented on the reconciliation — it is never
                        posted to the ledger.
                      </p>
                      <textarea
                        value={overrideReason}
                        onChange={(e) => setOverrideReason(e.target.value)}
                        rows={2}
                        maxLength={500}
                        placeholder="Why is this difference acceptable to finalize? (min 8 characters)"
                        className="w-full rounded-md border border-slate-700 bg-slate-900/60 px-2.5 py-2 text-sm text-slate-200 placeholder-slate-600 focus:border-amber-500/40 focus:outline-none focus:ring-1 focus:ring-amber-500/40"
                      />
                      <div className="mt-3 flex items-center justify-end gap-2">
                        <button
                          onClick={() => { setOverrideOpen(false); setOverrideReason(''); }}
                          className="rounded-md px-3 py-1.5 text-xs text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={submitOverride}
                          disabled={busy === 'finalize' || overrideReason.trim().length < 8}
                          className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {busy === 'finalize' ? <Loader2 size={13} className="animate-spin" /> : <Lock size={13} />}
                          Override &amp; finalize
                        </button>
                      </div>
                    </>
                  ) : (
                    <p className="text-xs text-amber-300/80">
                      Override is unavailable in this environment (the reconciliation-override migration has not been
                      applied). Resolve the difference to $0 to finalize.
                    </p>
                  )}
                </div>
              )}

              {/* AI-drafted adjusting entries (RECON_ADJUSTMENT) — propose → human approves */}
              {rec && !finalized && proposals.length > 0 && (
                <div className="mb-4 rounded-lg border border-indigo-500/25 bg-indigo-500/[0.05] p-4">
                  <div className="mb-3 flex items-center gap-1.5 text-sm font-medium text-white">
                    <Sparkles size={14} className="text-indigo-400" />
                    Suggested adjustments
                    <span className="ml-1 rounded bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-medium text-indigo-300">
                      {proposals.length}
                    </span>
                    <span className="ml-auto text-2xs font-normal text-slate-500">AI proposes · you approve</span>
                  </div>
                  <ul className="space-y-2">
                    {proposals.map((p) => (
                      <li
                        key={p.sourceTransactionId}
                        className="flex items-start justify-between gap-3 rounded-md border border-slate-700/60 bg-slate-900/50 px-3 py-2.5"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="rounded bg-slate-700/60 px-1.5 py-0.5 text-[10px] font-medium text-slate-300">
                              {CATEGORY_LABEL[p.category]}
                            </span>
                            <span className="truncate text-sm text-slate-200">{p.suggestedMemo}</span>
                            <span
                              className={clsx(
                                'font-mono text-sm tabular-nums',
                                p.cashEffect === 'decrease' ? 'text-red-400' : 'text-emerald-400',
                              )}
                            >
                              {p.cashEffect === 'decrease' ? '−' : '+'}
                              {formatMoney(p.amountCents)}
                            </span>
                          </div>
                          <p className="mt-1 text-2xs leading-relaxed text-slate-500">{p.reasoning}</p>
                          {p.needsOffsetAccount && (
                            <p className="mt-0.5 text-2xs text-amber-400/80">Needs an offset account — approve to choose it</p>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <button
                            onClick={() => approveProposal(p)}
                            disabled={busyProposal === p.sourceTransactionId}
                            className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                          >
                            {busyProposal === p.sourceTransactionId ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <Check size={12} />
                            )}
                            Approve
                          </button>
                          <button
                            onClick={() => rejectProposal(p.sourceTransactionId)}
                            disabled={busyProposal === p.sourceTransactionId}
                            className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:border-red-500/40 hover:text-red-300 disabled:opacity-50"
                          >
                            <Ban size={12} />
                            Reject
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Adjusting entry — book a bank fee / interest / correction so the rec ties */}
              {rec && !finalized && !showAdjust && (
                <button
                  onClick={openAdjust}
                  className="mb-4 inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800/40 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-brand-500/40 hover:text-white"
                >
                  <Plus size={13} /> Add adjustment
                </button>
              )}

              {rec && !finalized && showAdjust && (
                <div className="mb-4 rounded-lg border border-slate-700 bg-slate-800/40 p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-sm font-medium text-white">
                      <Receipt size={14} className="text-indigo-400" /> Adjusting entry
                    </span>
                    <button
                      onClick={() => setShowAdjust(false)}
                      className="rounded p-1 text-slate-500 hover:bg-white/[0.04] hover:text-slate-300"
                      aria-label="Cancel adjustment"
                    >
                      <X size={15} />
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <div>
                      <label className="mb-1 block text-2xs font-semibold uppercase tracking-wider text-slate-500">
                        Type
                      </label>
                      <select
                        value={adjType}
                        onChange={(e) => {
                          const t = e.target.value as AdjustmentType;
                          setAdjType(t);
                          setAdjOffsetId('');
                          if (t === 'bank_fee') setAdjCashEffect('decrease');
                          if (t === 'interest') setAdjCashEffect('increase');
                        }}
                        className="w-full rounded-md border border-slate-700 bg-slate-900/60 px-2.5 py-2 text-sm text-slate-200"
                      >
                        <option value="bank_fee">Bank fee</option>
                        <option value="interest">Interest income</option>
                        <option value="other">Other</option>
                      </select>
                    </div>

                    <div>
                      <label className="mb-1 block text-2xs font-semibold uppercase tracking-wider text-slate-500">
                        Amount
                      </label>
                      <div className="relative">
                        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-slate-500">$</span>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={adjAmount}
                          onChange={(e) => setAdjAmount(e.target.value)}
                          placeholder="0.00"
                          className="w-full rounded-md border border-slate-700 bg-slate-900/60 py-2 pl-6 pr-2.5 font-mono text-sm tabular-nums text-slate-200 placeholder-slate-600"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="mb-1 block text-2xs font-semibold uppercase tracking-wider text-slate-500">
                        Date
                      </label>
                      <input
                        type="date"
                        value={adjDate}
                        min={data.period.startDate}
                        max={data.period.endDate}
                        onChange={(e) => setAdjDate(e.target.value)}
                        className="w-full rounded-md border border-slate-700 bg-slate-900/60 px-2.5 py-2 text-sm text-slate-200"
                      />
                    </div>

                    {adjType !== 'bank_fee' && (
                      <div className="col-span-2 sm:col-span-2">
                        <label className="mb-1 block text-2xs font-semibold uppercase tracking-wider text-slate-500">
                          {adjType === 'interest' ? 'Income account' : 'Offset account'}
                        </label>
                        <select
                          value={adjOffsetId}
                          onChange={(e) => setAdjOffsetId(e.target.value)}
                          className="w-full rounded-md border border-slate-700 bg-slate-900/60 px-2.5 py-2 text-sm text-slate-200"
                        >
                          <option value="">Select account…</option>
                          {offsetOptions.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.account_number} · {a.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    {adjType === 'other' && (
                      <div>
                        <label className="mb-1 block text-2xs font-semibold uppercase tracking-wider text-slate-500">
                          Cash effect
                        </label>
                        <select
                          value={adjCashEffect}
                          onChange={(e) => setAdjCashEffect(e.target.value as 'increase' | 'decrease')}
                          className="w-full rounded-md border border-slate-700 bg-slate-900/60 px-2.5 py-2 text-sm text-slate-200"
                        >
                          <option value="decrease">Money out (charge)</option>
                          <option value="increase">Money in (credit)</option>
                        </select>
                      </div>
                    )}

                    <div className="col-span-2 sm:col-span-3">
                      <label className="mb-1 block text-2xs font-semibold uppercase tracking-wider text-slate-500">
                        Memo
                      </label>
                      <input
                        type="text"
                        value={adjMemo}
                        maxLength={200}
                        onChange={(e) => setAdjMemo(e.target.value)}
                        placeholder={adjType === 'bank_fee' ? 'Monthly service charge' : 'Description'}
                        className="w-full rounded-md border border-slate-700 bg-slate-900/60 px-2.5 py-2 text-sm text-slate-200 placeholder-slate-600"
                      />
                    </div>
                  </div>

                  <div className="mt-3 flex items-center justify-between">
                    <p className="text-2xs text-slate-500">
                      {adjType === 'bank_fee'
                        ? 'DR Bank Fees / CR Cash — posts and clears in this rec'
                        : adjType === 'interest'
                          ? 'DR Cash / CR Income — posts and clears in this rec'
                          : 'Balanced entry — posts and clears in this rec'}
                    </p>
                    <button
                      onClick={submitAdjustment}
                      disabled={busy === 'adjust'}
                      className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                    >
                      {busy === 'adjust' ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                      Post adjustment
                    </button>
                  </div>
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
          <div className="flex items-center gap-3 text-xs text-slate-500">
            {summary && rec && !finalized && (
              <span>
                {summary.clearedCount} cleared · {summary.unclearedCount} outstanding
              </span>
            )}
            {rec && (
              <button
                onClick={loadMemo}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800/40 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:border-indigo-500/40 hover:text-white"
              >
                <FileText size={13} className="text-indigo-400" /> Draft memo
              </button>
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
            ) : canFinalize ? (
              <button
                onClick={() => finalize()}
                disabled={busy === 'finalize'}
                title="Finalize and lock"
                className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
              >
                {busy === 'finalize' ? <Loader2 size={14} className="animate-spin" /> : <Lock size={14} />}
                Finalize &amp; lock
              </button>
            ) : rec && (summary?.hasPlug ?? false) && (summary?.clearedCount ?? 0) > 0 ? (
              <button
                onClick={() => setOverrideOpen(true)}
                disabled={overrideOpen}
                title="Finalize despite a non-zero difference (authorized override)"
                className="inline-flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-200 hover:bg-amber-500/20 disabled:opacity-50"
              >
                <ShieldAlert size={14} /> Finalize with override…
              </button>
            ) : (
              <button
                disabled
                title="Difference must be $0 with at least one cleared line"
                className="inline-flex cursor-not-allowed items-center gap-2 rounded-md bg-slate-800 px-4 py-2 text-sm font-medium text-slate-600"
              >
                <Lock size={14} /> Finalize &amp; lock
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Reconciliation memo drawer (AI phrases deterministic figures) */}
      {memoOpen && (
        <>
          <div className="fixed inset-0 z-[60] bg-black/50" onClick={() => setMemoOpen(false)} />
          <div className="fixed left-1/2 top-1/2 z-[70] flex max-h-[85vh] w-[620px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-slate-700 bg-surface-900 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
              <h3 className="flex items-center gap-2 text-base font-semibold text-white">
                <FileText size={16} className="text-indigo-400" /> Reconciliation memo
              </h3>
              <button
                onClick={() => setMemoOpen(false)}
                className="rounded-md p-1.5 text-slate-500 hover:bg-white/[0.04] hover:text-slate-200"
                aria-label="Close memo"
              >
                <X size={18} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {memoLoading ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 className="h-6 w-6 animate-spin text-indigo-400" />
                </div>
              ) : memoError ? (
                <div className="py-12 text-center">
                  <AlertCircle className="mx-auto mb-2 h-8 w-8 text-red-400" />
                  <p className="text-sm text-red-400">{memoError}</p>
                  <button
                    onClick={loadMemo}
                    className="mt-3 rounded-lg bg-slate-800 px-3.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
                  >
                    Try again
                  </button>
                </div>
              ) : memo ? (
                <>
                  <div className="mb-3 flex items-center gap-2 text-2xs text-slate-500">
                    <Sparkles size={12} className="text-indigo-400" />
                    {memo.meta.source === 'ai'
                      ? `Drafted by ${memo.meta.model ?? 'AI'} — figures computed in code`
                      : 'Deterministic draft — figures computed in code'}
                    {memo.meta.message ? ` · ${memo.meta.message}` : ''}
                  </div>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-200">{memo.memo}</p>

                  <div className="mt-4 grid grid-cols-2 gap-2 rounded-lg border border-slate-800 bg-slate-800/30 p-3 text-xs sm:grid-cols-4">
                    <div>
                      <p className="text-2xs uppercase tracking-wider text-slate-500">Cleared</p>
                      <p className="mt-0.5 font-mono text-slate-200">{memo.summary.clearedCount}</p>
                    </div>
                    <div>
                      <p className="text-2xs uppercase tracking-wider text-slate-500">Outstanding</p>
                      <p className="mt-0.5 font-mono text-slate-200">{memo.summary.outstandingCount}</p>
                    </div>
                    <div>
                      <p className="text-2xs uppercase tracking-wider text-slate-500">Stale</p>
                      <p className="mt-0.5 font-mono text-slate-200">{memo.summary.staleCount}</p>
                    </div>
                    <div>
                      <p className="text-2xs uppercase tracking-wider text-slate-500">Difference</p>
                      <p
                        className={clsx(
                          'mt-0.5 font-mono',
                          memo.summary.ties ? 'text-emerald-400' : 'text-red-400',
                        )}
                      >
                        {formatMoney(memo.summary.differenceCents)}
                      </p>
                    </div>
                  </div>
                </>
              ) : (
                <div className="py-12 text-center">
                  <FileText className="mx-auto mb-2 h-8 w-8 text-slate-600" />
                  <p className="text-sm text-slate-400">No memo yet.</p>
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-slate-800 px-5 py-4">
              <button
                onClick={() => setMemoOpen(false)}
                className="rounded-md px-4 py-2 text-sm text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"
              >
                Close
              </button>
              <button
                onClick={copyMemo}
                disabled={!memo?.memo}
                className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                <FileText size={14} /> Copy memo
              </button>
            </div>
          </div>
        </>
      )}
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
