'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import clsx from 'clsx';
import {
  Loader2,
  ShieldAlert,
  AlertTriangle,
  CheckCircle2,
  Banknote,
  ArrowRight,
} from 'lucide-react';

// Client action for the job Retainage page: release accumulated retainage back
// to the owner at closeout. Amount defaults to the FULL outstanding and can be
// reduced (partial release); validated 0 < amount <= outstanding. Releasing is
// a MONEY step, so it takes a two-step inline confirm (arm → fire) — no
// window.confirm. On success we DON'T emit anything: a DRAFT billing request is
// created and we link the operator to /billing to issue it.

const usdExact = (cents: number): string =>
  (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

// dollars string -> integer cents (display + pre-validation; server re-derives).
function parseDollarsToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

function extractError(payload: unknown): string | null {
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const value = (payload as { error?: unknown }).error;
    if (typeof value === 'string') return value;
  }
  return null;
}

type Phase = 'idle' | 'armed' | 'submitting';

export function ReleaseRetainage({
  jobId,
  outstandingCents,
}: {
  jobId: string;
  outstandingCents: number;
}) {
  const router = useRouter();
  const hasOutstanding = outstandingCents > 0;

  const [amount, setAmount] = useState<string>(
    hasOutstanding ? (outstandingCents / 100).toFixed(2) : '',
  );
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  const amountCents = useMemo(() => parseDollarsToCents(amount), [amount]);

  const validationError = useMemo((): string | null => {
    if (!hasOutstanding) return 'No outstanding retainage to release.';
    if (amountCents === null) return 'Enter an amount.';
    if (amountCents <= 0) return 'Amount must be greater than 0.';
    if (amountCents > outstandingCents)
      return `Amount can't exceed the outstanding ${usdExact(outstandingCents)}.`;
    return null;
  }, [hasOutstanding, amountCents, outstandingCents]);

  const isFull = amountCents !== null && amountCents === outstandingCents;

  const fire = async () => {
    if (validationError || amountCents === null) {
      setError(validationError);
      setPhase('idle');
      return;
    }
    setPhase('submitting');
    setError(null);
    try {
      const res = await fetch('/api/billing/retainage/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId,
          // omit amountCents when releasing the full outstanding.
          amountCents: isFull ? undefined : amountCents,
        }),
      });
      const payload: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setError(extractError(payload) ?? `Release failed (${res.status}).`);
        setPhase('idle');
        return;
      }
      const id =
        payload && typeof payload === 'object' && 'billingRequestId' in payload
          ? ((payload as { billingRequestId?: unknown }).billingRequestId ?? null)
          : null;
      setCreatedId(typeof id === 'string' ? id : '');
      setPhase('idle');
      router.refresh();
    } catch {
      setError('Network error — nothing was released.');
      setPhase('idle');
    }
  };

  // Success: the DRAFT is created; point the operator at /billing to issue it.
  if (createdId !== null) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-brand-500/40 bg-brand-500/5 p-4">
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-brand-400" />
        <div className="space-y-2">
          <p className="text-sm text-slate-200">
            <span className="font-semibold text-brand-300">Retainage release drafted.</span> A DRAFT
            billing request was created. It is not billed until you issue it.
          </p>
          <Link
            href="/billing"
            className="inline-flex items-center gap-1.5 rounded-lg border border-brand-500/40 bg-brand-500/10 px-3 py-1.5 text-2xs font-medium text-brand-300 hover:bg-brand-500/20"
          >
            Go to Billing to issue it
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
    );
  }

  return (
    <section className="rounded-xl border border-surface-800 bg-surface-900 p-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-heading text-white">
            <Banknote className="h-5 w-5 text-brand-400" />
            Release retainage
          </div>
          <p className="max-w-md text-2xs text-slate-500">
            Bill accumulated retainage back at closeout. Defaults to the full outstanding; reduce it
            for a partial release. Creates a DRAFT you issue from Billing.
          </p>
        </div>

        <div className="flex items-end gap-2">
          <label className="block">
            <span className="mb-1.5 block text-2xs uppercase tracking-wider text-slate-500">
              Amount
            </span>
            <div className="relative w-44">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">
                $
              </span>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={amount}
                disabled={!hasOutstanding || phase === 'submitting'}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setError(null);
                  if (phase === 'armed') setPhase('idle');
                }}
                placeholder="0.00"
                className={clsx(
                  'num w-full rounded-lg border bg-surface-950 py-2 pl-6 pr-3 text-right text-sm text-white placeholder:text-slate-600 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50',
                  validationError && amount.trim()
                    ? 'border-danger/50 focus:border-danger/60'
                    : 'border-surface-800 focus:border-brand-500/50',
                )}
              />
            </div>
          </label>

          {phase === 'submitting' ? (
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-surface-800 px-3 py-2 text-2xs font-medium text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              Releasing…
            </span>
          ) : phase === 'armed' ? (
            <div className="inline-flex items-center gap-1">
              <button
                type="button"
                onClick={fire}
                className="inline-flex items-center gap-1.5 rounded-lg border border-warning/50 bg-warning/10 px-3 py-2 text-2xs font-semibold text-warning-fg hover:bg-warning/20"
                title="Creates a DRAFT retainage-release billing request"
              >
                <ShieldAlert className="h-3.5 w-3.5" />
                Confirm {isFull ? 'full' : 'partial'} release
              </button>
              <button
                type="button"
                onClick={() => setPhase('idle')}
                className="rounded-lg border border-surface-800 px-2.5 py-2 text-2xs font-medium text-slate-400 hover:bg-surface-850"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                if (validationError) {
                  setError(validationError);
                  return;
                }
                setError(null);
                setPhase('armed');
              }}
              disabled={!hasOutstanding || validationError !== null}
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors',
                !hasOutstanding || validationError !== null
                  ? 'cursor-not-allowed bg-surface-800 text-slate-500'
                  : 'bg-brand-500 text-surface-950 hover:bg-brand-400',
              )}
            >
              <Banknote className="h-4 w-4" />
              Release
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger-fg" />
          <span className="text-sm text-danger-fg">{error}</span>
        </div>
      )}
    </section>
  );
}
