'use client';

/**
 * ConfidenceExplainer — an inline, read-only "why this confidence?" surface for a
 * single bank-feed row. It reuses the existing deterministic insight endpoint
 * (`/api/bank-feed/[id]/insight`) which computes the DOCUMENTED composite match
 * score (Vendor 40% + Amount 40% + Date 20%) and the auto-approve check breakdown
 * server-side. NOTHING here calls a live model — it's pure arithmetic surfaced to
 * the reviewer, so it works even while AI categorization is unavailable.
 *
 * Presented as a small modal dialog (role="dialog", Esc / backdrop to close) so it
 * never gets clipped by the table's horizontal scroll and stays keyboard-usable.
 */

import { useEffect } from 'react';
import { clsx } from 'clsx';
import { Sparkles, Zap, X, Check, AlertCircle, Loader2 } from 'lucide-react';
import { formatMoney, type BankFeedRow } from '@meritbooks/shared';
import { useQuery } from '@/hooks';

interface AutoApproveInsight {
  eligible: boolean;
  tier: 'auto' | 'review' | 'escalate';
  reason: string;
  confidence: number | null;
  amountCents: number;
  autoThreshold: number;
  autoMaxCents: number | null;
  trustedVendor: boolean | null;
  checks: { confidenceOk: boolean; amountOk: boolean; vendorTrusted: boolean };
}
interface MatchBreakdownInsight {
  breakdown: {
    score: number;
    vendorScore: number;
    amountScore: number;
    dateScore: number;
    explanation: string;
  } | null;
  candidateLabel: string | null;
  matchType: string | null;
  matchConfidence: number | null;
}
interface InsightResponse {
  autoApprove: AutoApproveInsight;
  match: MatchBreakdownInsight;
}

function ScoreBar({ label, weight, value }: { label: string; weight: string; value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const color = pct >= 85 ? 'bg-emerald-500' : pct >= 50 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 text-2xs text-slate-400">{label}</span>
      <span className="w-8 text-2xs text-slate-600 tabular-nums">{weight}</span>
      <div className="flex-1 h-1.5 rounded-full bg-slate-800 overflow-hidden">
        <div className={clsx('h-full rounded-full transition-all', color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-9 text-right text-2xs font-mono tabular-nums text-slate-400">{pct}%</span>
    </div>
  );
}

function AutoCheck({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={clsx(
          'inline-flex items-center justify-center w-3.5 h-3.5 rounded-full shrink-0',
          ok ? 'text-emerald-400' : 'text-slate-600',
        )}
      >
        {ok ? <Check size={11} /> : <X size={11} />}
      </span>
      <span className={clsx('text-2xs', ok ? 'text-slate-300' : 'text-slate-500')}>{label}</span>
    </div>
  );
}

export function ConfidenceExplainer({
  transaction,
  onClose,
}: {
  transaction: BankFeedRow;
  onClose: () => void;
}) {
  const { data: insight, isLoading, error } = useQuery<InsightResponse>(
    `/api/bank-feed/${transaction.id}/insight`,
    undefined,
    { scope: false },
  );

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);

  const aiPct = transaction.ai_confidence == null ? null : Math.round(transaction.ai_confidence * 100);

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="conf-explainer-title"
        className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[460px] max-w-[92vw] bg-surface-900 border border-slate-800 rounded-xl shadow-2xl z-50 p-5"
      >
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <h3 id="conf-explainer-title" className="text-sm font-semibold text-white flex items-center gap-1.5">
              <Sparkles size={13} className="text-indigo-400 shrink-0" />
              Why this confidence
            </h3>
            <p className="text-2xs text-slate-500 mt-0.5 truncate">{transaction.description}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-slate-500 hover:text-slate-200 hover:bg-white/[0.04] transition-colors shrink-0"
            aria-label="Close explanation"
          >
            <X size={14} />
          </button>
        </div>

        {/* Overall AI confidence */}
        <div className="flex items-center justify-between rounded-lg bg-slate-800/40 border border-slate-800 px-3 py-2 mb-3">
          <span className="text-2xs uppercase tracking-wider font-semibold text-slate-400">AI confidence</span>
          <span
            className={clsx(
              'text-sm font-mono tabular-nums font-semibold',
              aiPct == null ? 'text-slate-500' : aiPct >= 85 ? 'text-emerald-400' : aiPct >= 70 ? 'text-amber-400' : 'text-red-400',
            )}
          >
            {aiPct == null ? 'Uncoded' : `${aiPct}%`}
          </span>
        </div>

        {isLoading && (
          <div className="flex items-center gap-2 py-4 text-2xs text-slate-500">
            <Loader2 size={13} className="animate-spin" /> Computing the score breakdown…
          </div>
        )}

        {error && !isLoading && (
          <div className="flex items-center gap-2 py-4 text-2xs text-amber-400">
            <AlertCircle size={13} /> Could not load the score breakdown.
          </div>
        )}

        {!isLoading && !error && insight && (
          <div className="space-y-3">
            {/* Composite match breakdown — Vendor 40% + Amount 40% + Date 20% */}
            {insight.match?.breakdown ? (
              <div className="rounded-lg border border-blue-500/15 bg-blue-500/[0.04] p-3">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-2xs uppercase tracking-wider font-semibold text-slate-400">Match score</span>
                  {insight.match.candidateLabel && (
                    <span className="text-2xs text-slate-500 truncate">vs {insight.match.candidateLabel}</span>
                  )}
                  <span className="ml-auto text-sm font-mono tabular-nums text-blue-300 font-semibold">
                    {Math.round(insight.match.breakdown.score * 100)}%
                  </span>
                </div>
                <div className="space-y-1.5">
                  <ScoreBar label="Vendor" weight="40%" value={insight.match.breakdown.vendorScore} />
                  <ScoreBar label="Amount" weight="40%" value={insight.match.breakdown.amountScore} />
                  <ScoreBar label="Date" weight="20%" value={insight.match.breakdown.dateScore} />
                </div>
                <p className="text-2xs text-slate-500 mt-2 leading-relaxed">{insight.match.breakdown.explanation}</p>
              </div>
            ) : (
              <p className="text-2xs text-slate-500 leading-relaxed">
                {insight.match?.matchType && insight.match.matchType !== 'NONE'
                  ? 'Matched by vendor pattern — there is no settled bill to compare amount and date against, so the composite Vendor/Amount/Date split is not applicable here.'
                  : 'No bill or receipt is matched to this line, so there is no composite Vendor/Amount/Date score to break down. The AI confidence above reflects the categorization suggestion only.'}
              </p>
            )}

            {/* Auto-approve check breakdown */}
            {insight.autoApprove && (
              <div
                className={clsx(
                  'rounded-lg border p-3',
                  insight.autoApprove.eligible ? 'border-emerald-500/20 bg-emerald-500/[0.05]' : 'border-slate-700 bg-slate-800/40',
                )}
              >
                <div className="flex items-center gap-2 mb-2">
                  <Zap size={13} className={insight.autoApprove.eligible ? 'text-emerald-400' : 'text-slate-500'} />
                  <span className="text-2xs uppercase tracking-wider font-semibold text-slate-400">Auto-approve</span>
                  <span
                    className={clsx(
                      'ml-auto text-2xs font-medium px-2 py-0.5 rounded-full',
                      insight.autoApprove.eligible ? 'text-emerald-400 bg-emerald-500/10' : 'text-amber-400 bg-amber-500/10',
                    )}
                  >
                    {insight.autoApprove.eligible ? 'Eligible' : 'Needs review'}
                  </span>
                </div>
                <div className="space-y-1">
                  <AutoCheck
                    ok={insight.autoApprove.checks.confidenceOk}
                    label={`Confidence ${insight.autoApprove.confidence == null ? '—' : `${Math.round(insight.autoApprove.confidence * 100)}%`} ≥ ${Math.round(insight.autoApprove.autoThreshold * 100)}%`}
                  />
                  <AutoCheck
                    ok={insight.autoApprove.checks.amountOk}
                    label={`Amount ${formatMoney(insight.autoApprove.amountCents)} ≤ ${insight.autoApprove.autoMaxCents == null ? 'no cap' : formatMoney(insight.autoApprove.autoMaxCents)}`}
                  />
                  <AutoCheck
                    ok={insight.autoApprove.checks.vendorTrusted}
                    label={
                      insight.autoApprove.trustedVendor == null
                        ? 'Trusted vendor (no vendor identified)'
                        : insight.autoApprove.trustedVendor
                          ? 'Trusted vendor'
                          : 'Trusted vendor (not marked trusted)'
                    }
                  />
                </div>
                <p className="text-2xs text-slate-500 mt-2 leading-relaxed">{insight.autoApprove.reason}</p>
              </div>
            )}

            {/* AI reasoning fallback (deterministic text already stored on the row) */}
            {transaction.ai_reasoning && (
              <div className="rounded-lg border border-slate-800 bg-slate-800/30 p-3">
                <span className="text-2xs uppercase tracking-wider font-semibold text-slate-400">AI reasoning</span>
                <p className="text-2xs text-slate-400 mt-1 leading-relaxed">{transaction.ai_reasoning}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
