'use client';

/**
 * PaymentFraudCard — the payment-review fraud surface.
 *
 * Given a bill (a pending AP disbursement), it screens it via
 * POST /api/controls/payment-fraud and renders the risk VERDICT
 * (clear / review / block) with the individual flags and a plain-language
 * explanation.
 *
 * IMPORTANT — this card never moves money. For a review/block verdict it shows an
 * explicit HUMAN OVERRIDE affordance (type a reason → acknowledge) and calls the
 * `onOverride` callback so the surrounding release UI can proceed through the
 * existing gated release path. The card itself neither releases nor posts; a
 * person decides, and the actual transfer stays in lib/money/approvals.ts.
 *
 * Designed to embed on the bill/payment review screen. It also self-fetches, so it
 * works standalone (e.g. opened from an /exceptions PAYMENT_FRAUD row).
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  Loader2,
  AlertTriangle,
  Sparkles,
  Ban,
  CheckCircle2,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '@/lib/api-client';

type RiskLevel = 'clear' | 'review' | 'block';
type FraudSeverity = 'info' | 'warn' | 'critical';

interface FraudFlag {
  code: string;
  severity: FraudSeverity;
  message: string;
  detail: Record<string, unknown>;
}

interface RiskVerdict {
  level: RiskLevel;
  flags: FraudFlag[];
  explanation: string;
  score: number;
}

interface ScreenResult {
  ok: boolean;
  paymentId: string;
  verdict: RiskVerdict;
  aiExplanation: string | null;
  decisionId: string | null;
  error?: string;
}

interface ScreenResponse {
  data: ScreenResult;
  summary: { screened: number; clear: number; review: number; block: number };
}

export interface PaymentFraudCardProps {
  /** the bill about to be paid. */
  billId: string;
  /** override the amount screened (defaults to the bill's outstanding balance). */
  amountCents?: number;
  /** ask the AI gateway to phrase the flags (metered; off by default). */
  explain?: boolean;
  /** screen automatically on mount (default true). */
  autoRun?: boolean;
  /**
   * Called when a human explicitly overrides a review/block verdict to let the
   * payment proceed. The card does NOT move money — the caller routes the override
   * into the gated release path. Receives the verdict + typed reason.
   */
  onOverride?: (args: { verdict: RiskVerdict; reason: string }) => void;
}

const LEVEL_META: Record<
  RiskLevel,
  { label: string; icon: typeof ShieldCheck; ring: string; text: string; chip: string }
> = {
  clear: {
    label: 'Cleared',
    icon: ShieldCheck,
    ring: 'border-emerald-500/30 bg-emerald-500/5',
    text: 'text-emerald-400',
    chip: 'bg-emerald-500/10 text-emerald-400',
  },
  review: {
    label: 'Needs review',
    icon: ShieldAlert,
    ring: 'border-amber-500/30 bg-amber-500/5',
    text: 'text-amber-400',
    chip: 'bg-amber-500/10 text-amber-400',
  },
  block: {
    label: 'Blocked — fraud risk',
    icon: ShieldX,
    ring: 'border-red-500/40 bg-red-500/5',
    text: 'text-red-400',
    chip: 'bg-red-500/10 text-red-400',
  },
};

const SEVERITY_CHIP: Record<FraudSeverity, string> = {
  info: 'bg-slate-500/10 text-slate-300',
  warn: 'bg-amber-500/10 text-amber-400',
  critical: 'bg-red-500/10 text-red-400',
};

const FLAG_LABEL: Record<string, string> = {
  NEW_PAYEE: 'New payee',
  BANK_DETAIL_CHANGE: 'Bank details changed',
  UNUSUAL_AMOUNT: 'Unusual amount',
  DUPLICATE: 'Possible duplicate',
  ROUND_DOLLAR_FIRST_LARGE: 'Round-dollar first-large',
};

export function PaymentFraudCard({
  billId,
  amountCents,
  explain = false,
  autoRun = true,
  onOverride,
}: PaymentFraudCardProps) {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [result, setResult] = useState<ScreenResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [overridden, setOverridden] = useState(false);

  const run = useCallback(async () => {
    setState('loading');
    setErrorMsg(null);
    const res = await api.post<ScreenResponse>('/api/controls/payment-fraud', {
      billId,
      amountCents,
      explain,
    });
    if (res.error) {
      setErrorMsg(res.error.error || 'Screen failed');
      setState('error');
      return;
    }
    setResult(res.data?.data ?? null);
    setState('done');
  }, [billId, amountCents, explain]);

  useEffect(() => {
    if (autoRun) void run();
  }, [autoRun, run]);

  const verdict = result?.verdict ?? null;
  const meta = verdict ? LEVEL_META[verdict.level] : LEVEL_META.review;
  const Icon = meta.icon;

  function confirmOverride() {
    if (!verdict || overrideReason.trim().length < 4) return;
    setOverridden(true);
    setOverrideOpen(false);
    onOverride?.({ verdict, reason: overrideReason.trim() });
  }

  // ── States ──────────────────────────────────────────────────────────────────
  if (state === 'loading' || state === 'idle') {
    return (
      <div className="card flex items-center gap-3 p-4 text-sm text-slate-400">
        <Loader2 className="h-4 w-4 animate-spin text-emerald-400" />
        Screening this payment for fraud indicators…
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="card border-red-500/30 bg-red-500/5 p-4">
        <div className="flex items-center gap-2 text-sm text-red-400">
          <AlertTriangle className="h-4 w-4" />
          {errorMsg}
        </div>
        <button
          type="button"
          onClick={() => void run()}
          className="mt-3 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
        >
          Retry screen
        </button>
      </div>
    );
  }

  if (!verdict) return null;

  return (
    <div className={clsx('card overflow-hidden border p-0', meta.ring)}>
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-slate-800/60 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <Icon className={clsx('h-5 w-5', meta.text)} />
          <div>
            <p className={clsx('text-sm font-semibold', meta.text)}>{meta.label}</p>
            <p className="text-[11px] text-slate-500">Payment-run fraud screen</p>
          </div>
        </div>
        <span
          className={clsx(
            'inline-flex shrink-0 items-center rounded px-2 py-0.5 font-mono text-[11px] font-medium',
            meta.chip,
          )}
        >
          risk {Math.round(verdict.score * 100)}%
        </span>
      </div>

      {/* Explanation */}
      <div className="px-4 py-3">
        {result?.aiExplanation && (
          <div className="mb-3 flex items-start gap-2 rounded-lg bg-indigo-500/5 px-3 py-2 text-xs text-indigo-200">
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo-400" />
            <span>{result.aiExplanation}</span>
          </div>
        )}

        {verdict.flags.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-emerald-400">
            <CheckCircle2 className="h-4 w-4" />
            No fraud indicators found. Cleared for the normal approval path.
          </div>
        ) : (
          <ul className="space-y-2">
            {verdict.flags.map((f, i) => (
              <li key={`${f.code}-${i}`} className="flex items-start gap-2.5">
                <span
                  className={clsx(
                    'mt-0.5 inline-flex shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                    SEVERITY_CHIP[f.severity],
                  )}
                >
                  {FLAG_LABEL[f.code] ?? f.code}
                </span>
                <span className="text-xs leading-relaxed text-slate-300">{f.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Override affordance — only for review/block, and only if a handler exists. */}
      {verdict.level !== 'clear' && onOverride && (
        <div className="border-t border-slate-800/60 bg-slate-950/40 px-4 py-3">
          {overridden ? (
            <div className="flex items-center gap-2 text-xs text-amber-400">
              <ShieldAlert className="h-4 w-4" />
              Override recorded — the payment may proceed through the normal release
              approval. This screen does not release funds.
            </div>
          ) : !overrideOpen ? (
            <div className="flex items-center justify-between gap-3">
              <p className="flex items-center gap-1.5 text-[11px] text-slate-500">
                <Ban className="h-3.5 w-3.5" />
                {verdict.level === 'block'
                  ? 'Release is blocked. A person must explicitly override to proceed.'
                  : 'A person should confirm before this payment is released.'}
              </p>
              <button
                type="button"
                onClick={() => setOverrideOpen(true)}
                className={clsx(
                  'shrink-0 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                  verdict.level === 'block'
                    ? 'border-red-500/40 text-red-300 hover:bg-red-500/10'
                    : 'border-amber-500/40 text-amber-300 hover:bg-amber-500/10',
                )}
              >
                Override to proceed
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <label className="block text-[11px] font-medium text-slate-400">
                Reason for overriding (required — recorded for audit)
              </label>
              <textarea
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                rows={2}
                placeholder="e.g. Verified new bank details by phone with the vendor's AP contact."
                className="w-full resize-none rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-2 text-xs text-slate-200 placeholder:text-slate-600 focus:border-emerald-500/40 focus:outline-none"
              />
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setOverrideOpen(false);
                    setOverrideReason('');
                  }}
                  className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-slate-200"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={overrideReason.trim().length < 4}
                  onClick={confirmOverride}
                  className="rounded-lg bg-red-500/90 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Acknowledge &amp; override
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default PaymentFraudCard;
