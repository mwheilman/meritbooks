'use client';

import { useMemo, useState } from 'react';
import {
  Loader2,
  AlertCircle,
  Building2,
  CreditCard,
  CheckCircle2,
  Sparkles,
  Link2,
  Flag,
  Zap,
  ArrowUpRight,
  ArrowDownLeft,
  ScanSearch,
  Lock,
} from 'lucide-react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { useQuery, addToast } from '@/hooks';
import { api } from '@/lib/api-client';
import { ConfidenceBar } from '@/components/ui';

// ── Types (mirror /api/reconciliation/autopilot) ────────────────────────────────

interface AccountOption {
  id: string;
  accountName: string;
  accountMask: string;
  accountType: string;
  currentBalanceCents: number;
  locationId: string;
  locationName: string;
  locationCode: string;
}

type Tier = 'auto' | 'review' | 'escalate';

interface Proposal {
  candidateType: 'bill' | 'pattern' | 'none';
  candidateId: string | null;
  candidateLabel: string;
  confidence: number;
  breakdown: { vendor: number; amount: number; date: number } | null;
  reason: string;
  tier: Tier;
  tierReason: string;
}

interface UnmatchedRow {
  id: string;
  description: string;
  amountCents: number;
  absCents: number;
  isOutflow: boolean;
  transactionDate: string;
  status: string;
  reconciled: boolean;
  persisted: { matched: boolean; type: string | null; billId: string | null; confidence: number | null } | null;
  proposal: Proposal;
}

interface MatchedRow {
  id: string;
  description: string;
  amountCents: number;
  transactionDate: string;
  glEntryId: string | null;
  glEntryNumber: string | null;
  reconciled: boolean;
}

interface Detail {
  account: {
    id: string;
    accountName: string;
    accountMask: string;
    accountType: string;
    locationId: string;
    locationName: string;
    locationCode: string;
  };
  period: { id: string; year: number; month: number; startDate: string; endDate: string; status: string };
  summary: {
    glCashBalanceCents: number;
    statementBalanceCents: number | null;
    differenceCents: number | null;
    isReconciled: boolean;
    clearedCount: number;
    clearedAmountCents: number;
    unclearedCount: number;
    unclearedAmountCents: number;
    autoCount: number;
    reviewCount: number;
    escalateCount: number;
  };
  matched: MatchedRow[];
  unmatched: UnmatchedRow[];
}

interface AutopilotResponse {
  accounts: AccountOption[];
  detail: Detail | null;
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

const TIER_META: Record<Tier, { label: string; cls: string }> = {
  auto: { label: 'Auto', cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' },
  review: { label: 'Review', cls: 'bg-amber-500/10 text-amber-400 border-amber-500/30' },
  escalate: { label: 'Escalate', cls: 'bg-red-500/10 text-red-400 border-red-500/30' },
};

// ── Component ────────────────────────────────────────────────────────────────────

export function ReconciliationAutopilot() {
  const currentYear = new Date().getUTCFullYear();
  const [accountId, setAccountId] = useState('');
  const [year, setYear] = useState(currentYear);
  const [periodId, setPeriodId] = useState('');
  const [tab, setTab] = useState<'unmatched' | 'matched'>('unmatched');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkRunning, setBulkRunning] = useState(false);

  // Single query drives both the account list and (when selected) the detail.
  const params: Record<string, string> = {};
  if (accountId) params.bank_account_id = accountId;
  if (periodId) params.fiscal_period_id = periodId;
  const { data, isLoading, error, refetch } = useQuery<AutopilotResponse>(
    '/api/reconciliation/autopilot',
    params,
  );

  const accounts = data?.accounts ?? [];
  const selectedAccount = accounts.find((a) => a.id === accountId) ?? null;

  // Period options for the selected account's company.
  const { data: periodData } = useQuery<PeriodResponse>(
    selectedAccount ? '/api/periods' : null,
    { year: String(year) },
  );
  const availablePeriods = useMemo(() => {
    if (!selectedAccount) return [] as Array<{ periodId: string; label: string }>;
    const row = (periodData?.grid ?? []).find((g) => g.locationId === selectedAccount.locationId);
    if (!row) return [];
    return row.months
      .filter((m) => m.periodId)
      .map((m) => ({ periodId: m.periodId as string, label: `${MONTHS[m.month - 1]} ${year}` }));
  }, [periodData, selectedAccount, year]);

  const detail = data?.detail ?? null;

  async function disposition(row: UnmatchedRow, action: 'accept' | 'reject') {
    setBusyId(row.id);
    const result = await api.post<{ ok: boolean }>('/api/reconciliation/autopilot/match', {
      transaction_id: row.id,
      action,
      candidate_type: row.proposal.candidateType,
      candidate_id: row.proposal.candidateId,
      confidence: row.proposal.confidence,
      tier: row.proposal.tier,
    });
    setBusyId(null);
    if (result.error) {
      addToast('error', result.error.error || 'Could not update match');
      return;
    }
    addToast(
      'success',
      action === 'accept' ? 'Match accepted — staged to clear' : 'Flagged — sent to Needs Attention',
    );
    await refetch();
  }

  async function bulkAutoClear() {
    if (!detail) return;
    const targets = detail.unmatched.filter(
      (u) => u.proposal.tier === 'auto' && u.proposal.candidateType !== 'none' && !u.persisted && !u.reconciled,
    );
    if (targets.length === 0) {
      addToast('success', 'No auto-tier matches to clear');
      return;
    }
    setBulkRunning(true);
    let ok = 0;
    for (const row of targets) {
      const result = await api.post<{ ok: boolean }>('/api/reconciliation/autopilot/match', {
        transaction_id: row.id,
        action: 'accept',
        candidate_type: row.proposal.candidateType,
        candidate_id: row.proposal.candidateId,
        confidence: row.proposal.confidence,
        tier: row.proposal.tier,
      });
      if (!result.error) ok += 1;
    }
    setBulkRunning(false);
    addToast(ok > 0 ? 'success' : 'error', `Auto-cleared ${ok} of ${targets.length} high-confidence matches`);
    await refetch();
  }

  // ── States: loading / error (account list) ────────────────────────────────────
  if (isLoading && !data) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-emerald-400" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="card p-10 text-center">
        <AlertCircle className="mx-auto mb-3 h-8 w-8 text-red-400" />
        <p className="text-sm text-red-400">{error}</p>
        <button
          onClick={() => refetch()}
          className="mt-4 rounded-lg bg-slate-800 px-3.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
        >
          Try again
        </button>
      </div>
    );
  }

  const autoStageable = detail
    ? detail.unmatched.filter((u) => u.proposal.tier === 'auto' && u.proposal.candidateType !== 'none' && !u.persisted && !u.reconciled).length
    : 0;

  return (
    <div className="space-y-6">
      {/* Selectors */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <CreditCard className="h-4 w-4 text-slate-500" />
          <select
            value={accountId}
            aria-label="Bank account"
            onChange={(e) => {
              setAccountId(e.target.value);
              setPeriodId('');
            }}
            className="rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-200"
          >
            <option value="">Select bank account…</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.accountName} {a.accountMask ? `·· ${a.accountMask}` : ''} ({a.locationCode})
              </option>
            ))}
          </select>
        </div>

        {selectedAccount && (
          <div className="flex items-center gap-2">
            <Building2 className="h-4 w-4 text-slate-500" />
            <select
              value={year}
              aria-label="Year"
              onChange={(e) => {
                setYear(parseInt(e.target.value, 10));
                setPeriodId('');
              }}
              className="rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-200"
            >
              {[currentYear + 1, currentYear, currentYear - 1, currentYear - 2].map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
            <select
              value={periodId}
              aria-label="Fiscal period"
              onChange={(e) => setPeriodId(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-200"
            >
              <option value="">Select period…</option>
              {availablePeriods.map((p) => (
                <option key={p.periodId} value={p.periodId}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* No accounts at all */}
      {accounts.length === 0 && (
        <div className="card p-16 text-center">
          <CreditCard className="mx-auto mb-3 h-10 w-10 text-slate-600" />
          <p className="text-sm font-medium text-white">No bank accounts connected</p>
          <p className="mt-1 text-xs text-slate-500">
            Connect a bank in the Statement Reconciliation tab to start clearing transactions.
          </p>
        </div>
      )}

      {/* Prompt to pick account/period */}
      {accounts.length > 0 && !detail && (
        <div className="card p-16 text-center">
          <ScanSearch className="mx-auto mb-3 h-10 w-10 text-indigo-400/70" />
          <p className="text-sm font-medium text-white">Choose an account and period to reconcile</p>
          <p className="mt-1 text-xs text-slate-500">
            The autopilot scores every uncleared statement line against your open bills and learned
            patterns, then tells you what to accept.
          </p>
        </div>
      )}

      {/* Detail */}
      {detail && (
        <>
          {/* Summary strip */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <SummaryCard
              label="GL cash (book)"
              value={formatMoney(detail.summary.glCashBalanceCents)}
              hint={`through ${detail.period.endDate}`}
            />
            <SummaryCard
              label="Statement balance"
              value={
                detail.summary.statementBalanceCents != null
                  ? formatMoney(detail.summary.statementBalanceCents)
                  : '—'
              }
              hint={detail.summary.statementBalanceCents != null ? 'from statement form' : 'not entered yet'}
            />
            <SummaryCard
              label="Difference"
              value={
                detail.summary.differenceCents != null
                  ? formatMoney(detail.summary.differenceCents)
                  : '—'
              }
              tone={
                detail.summary.differenceCents == null
                  ? 'muted'
                  : detail.summary.differenceCents === 0
                    ? 'good'
                    : 'bad'
              }
              hint={
                detail.summary.differenceCents === 0 && detail.summary.statementBalanceCents != null
                  ? 'ties exactly'
                  : 'book − statement'
              }
            />
            <SummaryCard
              label="Cleared / uncleared"
              value={`${detail.summary.clearedCount} / ${detail.summary.unclearedCount}`}
              hint={`${formatMoney(detail.summary.unclearedAmountCents)} uncleared`}
            />
          </div>

          {/* Tier tallies + autopilot action */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs">
              <TierPill tier="auto" count={detail.summary.autoCount} />
              <TierPill tier="review" count={detail.summary.reviewCount} />
              <TierPill tier="escalate" count={detail.summary.escalateCount} />
            </div>
            <button
              onClick={bulkAutoClear}
              disabled={bulkRunning || autoStageable === 0}
              className={clsx(
                'inline-flex items-center gap-2 rounded-lg border px-3.5 py-2 text-xs font-medium transition-colors',
                autoStageable > 0
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'
                  : 'cursor-not-allowed border-slate-800 bg-slate-800/30 text-slate-600',
              )}
            >
              {bulkRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
              Auto-clear {autoStageable} high-confidence
            </button>
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-1.5">
            {(['unmatched', 'matched'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={clsx(
                  'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                  tab === t
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                    : 'border-slate-800 bg-slate-800/30 text-slate-400 hover:text-slate-200',
                )}
              >
                {t === 'unmatched' ? 'Unmatched' : 'Matched'}
                <span className="ml-1.5 rounded bg-slate-700/50 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">
                  {t === 'unmatched' ? detail.unmatched.length : detail.matched.length}
                </span>
              </button>
            ))}
          </div>

          {/* Unmatched */}
          {tab === 'unmatched' &&
            (detail.unmatched.length === 0 ? (
              <div className="card p-12 text-center">
                <CheckCircle2 className="mx-auto mb-3 h-9 w-9 text-emerald-500/70" />
                <p className="text-sm font-medium text-white">Every line is cleared</p>
                <p className="mt-1 text-xs text-slate-500">
                  Nothing outstanding for this account and period.
                </p>
              </div>
            ) : (
              <div className="card divide-y divide-slate-800/40 overflow-hidden">
                {detail.unmatched.map((row) => (
                  <UnmatchedRowView
                    key={row.id}
                    row={row}
                    busy={busyId === row.id}
                    onAccept={() => disposition(row, 'accept')}
                    onReject={() => disposition(row, 'reject')}
                  />
                ))}
              </div>
            ))}

          {/* Matched */}
          {tab === 'matched' &&
            (detail.matched.length === 0 ? (
              <div className="card p-12 text-center">
                <AlertCircle className="mx-auto mb-3 h-8 w-8 text-slate-600" />
                <p className="text-sm text-slate-400">No cleared transactions yet for this period.</p>
              </div>
            ) : (
              <div className="card overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="border-b border-slate-800/50 text-left text-[11px] uppercase tracking-wider text-slate-500">
                      <th className="px-4 py-3">Date</th>
                      <th className="px-4 py-3">Description</th>
                      <th className="px-4 py-3">Journal entry</th>
                      <th className="px-4 py-3 text-right">Amount</th>
                      <th className="px-4 py-3">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/30">
                    {detail.matched.map((m) => (
                      <tr key={m.id} className="hover:bg-slate-800/20">
                        <td className="px-4 py-2.5 font-mono text-xs text-slate-400">{m.transactionDate}</td>
                        <td className="px-4 py-2.5 text-slate-200">{m.description}</td>
                        <td className="px-4 py-2.5 font-mono text-xs text-slate-400">
                          {m.glEntryNumber ?? '—'}
                        </td>
                        <td
                          className={clsx(
                            'px-4 py-2.5 text-right font-mono',
                            m.amountCents < 0 ? 'text-red-400' : 'text-emerald-400',
                          )}
                        >
                          {formatMoney(m.amountCents)}
                        </td>
                        <td className="px-4 py-2.5">
                          {m.reconciled ? (
                            <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
                              <Lock className="h-3.5 w-3.5" /> Reconciled
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs text-slate-300">
                              <CheckCircle2 className="h-3.5 w-3.5" /> Posted
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
        </>
      )}
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────────

function SummaryCard({
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
  const valueCls =
    tone === 'good'
      ? 'text-emerald-400'
      : tone === 'bad'
        ? 'text-red-400'
        : tone === 'muted'
          ? 'text-slate-500'
          : 'text-white';
  return (
    <div className="card px-4 py-3">
      <p className="text-[11px] uppercase tracking-wider text-slate-500">{label}</p>
      <p className={clsx('mt-1 font-mono text-lg tabular-nums', valueCls)}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-slate-600">{hint}</p>}
    </div>
  );
}

function TierPill({ tier, count }: { tier: Tier; count: number }) {
  const meta = TIER_META[tier];
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 font-medium', meta.cls)}>
      {meta.label}
      <span className="font-mono">{count}</span>
    </span>
  );
}

function UnmatchedRowView({
  row,
  busy,
  onAccept,
  onReject,
}: {
  row: UnmatchedRow;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  const { proposal } = row;
  const tierMeta = TIER_META[proposal.tier];
  const canAccept = proposal.candidateType !== 'none' && !row.persisted && !row.reconciled;

  return (
    <div className="flex flex-col gap-3 px-4 py-3 transition-colors hover:bg-slate-800/20 md:flex-row md:items-center">
      {/* Left: line identity */}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div
          className={clsx(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
            row.isOutflow ? 'bg-red-500/10' : 'bg-emerald-500/10',
          )}
        >
          {row.isOutflow ? (
            <ArrowUpRight className="h-4 w-4 text-red-400" />
          ) : (
            <ArrowDownLeft className="h-4 w-4 text-emerald-400" />
          )}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-white">{row.description}</p>
          <p className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-500">
            <span className="font-mono">{row.transactionDate}</span>
            {row.status === 'FLAGGED' && (
              <span className="inline-flex items-center gap-1 rounded bg-red-500/10 px-1.5 py-0.5 text-red-400">
                <Flag className="h-3 w-3" /> Flagged
              </span>
            )}
          </p>
        </div>
      </div>

      {/* Middle: AI proposal */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-indigo-400" />
          <span className="truncate text-xs text-slate-300" title={proposal.reason}>
            {proposal.candidateType === 'none' ? (
              <span className="text-slate-500">{proposal.candidateLabel}</span>
            ) : (
              <>
                <span className="text-slate-500">
                  {proposal.candidateType === 'bill' ? 'Settles bill' : 'Pattern'}:
                </span>{' '}
                {proposal.candidateLabel}
              </>
            )}
          </span>
          <span className={clsx('shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium', tierMeta.cls)}>
            {tierMeta.label}
          </span>
        </div>
        {proposal.candidateType !== 'none' && (
          <div className="mt-1.5 max-w-[220px]">
            <ConfidenceBar value={proposal.confidence} size="sm" />
          </div>
        )}
        {row.persisted && (
          <p className="mt-1 inline-flex items-center gap-1 text-[11px] text-emerald-400">
            <Link2 className="h-3 w-3" /> Match staged{row.persisted.type ? ` (${row.persisted.type})` : ''}
          </p>
        )}
        {row.reconciled && (
          <p className="mt-1 inline-flex items-center gap-1 text-[11px] text-emerald-400">
            <Lock className="h-3 w-3" /> Locked by a finalized reconciliation
          </p>
        )}
      </div>

      {/* Right: amount + actions */}
      <div className="flex shrink-0 items-center gap-4">
        <span className={clsx('font-mono text-sm', row.isOutflow ? 'text-red-400' : 'text-emerald-400')}>
          {formatMoney(row.amountCents)}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={onAccept}
            disabled={busy || !canAccept}
            title={canAccept ? 'Accept match' : 'No candidate to accept'}
            className={clsx(
              'inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors',
              canAccept
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'
                : 'cursor-not-allowed border-slate-800 bg-slate-800/30 text-slate-600',
              'disabled:opacity-50',
            )}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            Accept
          </button>
          <button
            onClick={onReject}
            disabled={busy || row.status === 'FLAGGED' || row.reconciled}
            title="Flag and send to Needs Attention"
            className={clsx(
              'inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/40 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-400',
              'disabled:cursor-not-allowed disabled:opacity-50',
            )}
          >
            <Flag className="h-3.5 w-3.5" />
            Flag
          </button>
        </div>
      </div>
    </div>
  );
}
