'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import {
  Plus,
  Trash2,
  X,
  Loader2,
  ShieldAlert,
  CheckCircle2,
  AlertTriangle,
  Send,
} from 'lucide-react';

// Client actions for the Billing page. Two responsibilities, both on the MONEY
// path:
//   1. NewDraw    — compose + POST a DRAFT draw (no event emitted).
//   2. IssueDraw  — approve + emit a DRAFT draw. Emitting is irreversible, so the
//                   button REQUIRES a two-step inline confirm (arm, then fire).
//                   No window.confirm/alert anywhere — the confirm is in the DOM.

// ---- Shared types ------------------------------------------------------------

export interface JobOption {
  id: string;
  jobNumber: string;
  name: string;
}

type BillingType = 'MILESTONE' | 'PROGRESS' | 'TIME_MATERIALS' | 'DRAW';

const BILLING_TYPES: { value: BillingType; label: string }[] = [
  { value: 'MILESTONE', label: 'Milestone' },
  { value: 'PROGRESS', label: 'Progress' },
  { value: 'TIME_MATERIALS', label: 'Time & Materials' },
  { value: 'DRAW', label: 'Draw' },
];

interface LineDraft {
  key: string;
  description: string;
  // raw dollar string as typed; parsed to a number only on submit / for totals.
  amount: string;
}

// ---- helpers -----------------------------------------------------------------

const usdExact = (cents: number): string =>
  (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

// dollars string -> integer cents (client-side, display + pre-validation only;
// the server re-derives the authoritative cents value).
function parseDollarsToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

function newLine(): LineDraft {
  return {
    key: Math.random().toString(36).slice(2),
    description: '',
    amount: '',
  };
}

const todayIso = (): string => new Date().toISOString().slice(0, 10);

// Narrow an unknown fetch payload to a { error?: string } shape without `any`.
function extractError(payload: unknown): string | null {
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const value = (payload as { error?: unknown }).error;
    if (typeof value === 'string') return value;
  }
  return null;
}

// ---- New draw ----------------------------------------------------------------

export function NewDraw({ jobs }: { jobs: JobOption[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const [jobId, setJobId] = useState('');
  const [billingType, setBillingType] = useState<BillingType>('PROGRESS');
  const [occurredOn, setOccurredOn] = useState(todayIso());
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([newLine()]);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totalCents = useMemo(
    () =>
      lines.reduce((sum, line) => {
        const cents = parseDollarsToCents(line.amount);
        return cents && cents > 0 ? sum + cents : sum;
      }, 0),
    [lines],
  );

  const reset = useCallback(() => {
    setJobId('');
    setBillingType('PROGRESS');
    setOccurredOn(todayIso());
    setMemo('');
    setLines([newLine()]);
    setError(null);
    setSubmitting(false);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    reset();
  }, [reset]);

  const updateLine = (key: string, patch: Partial<LineDraft>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const removeLine = (key: string) =>
    setLines((prev) => (prev.length > 1 ? prev.filter((l) => l.key !== key) : prev));

  // Client-side gate mirrors the server contract so we never fire an obviously
  // invalid request; the server re-validates authoritatively.
  const validationError = useMemo((): string | null => {
    if (!jobId) return 'Select a job.';
    const parsed = lines.map((l) => ({
      description: l.description.trim(),
      cents: parseDollarsToCents(l.amount),
    }));
    if (parsed.some((l) => !l.description)) return 'Every line needs a description.';
    if (parsed.some((l) => l.cents === null)) return 'Every line needs an amount.';
    if (parsed.some((l) => (l.cents ?? 0) <= 0)) return 'Line amounts must be greater than 0.';
    return null;
  }, [jobId, lines]);

  const submit = async () => {
    if (validationError) {
      setError(validationError);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/billing/draws', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_id: jobId,
          billing_type: billingType,
          occurred_on: occurredOn,
          memo: memo.trim() ? memo.trim() : undefined,
          lines: lines.map((l) => ({
            description: l.description.trim(),
            amount: Number(l.amount),
          })),
        }),
      });
      const payload: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setError(extractError(payload) ?? `Failed to create draw (${res.status}).`);
        setSubmitting(false);
        return;
      }
      close();
      router.refresh();
    } catch {
      setError('Network error — the draw was not created.');
      setSubmitting(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={jobs.length === 0}
        className={clsx(
          'inline-flex items-center gap-2 rounded-lg border px-3.5 py-2 text-sm font-medium transition-colors',
          jobs.length === 0
            ? 'cursor-not-allowed border-surface-800 bg-surface-900 text-slate-600'
            : 'border-brand-500/40 bg-brand-500/10 text-brand-300 hover:bg-brand-500/20',
        )}
        title={jobs.length === 0 ? 'No jobs available to bill against' : 'Create a new draw'}
      >
        <Plus className="h-4 w-4" />
        New draw
      </button>
    );
  }

  return (
    <div className="w-full rounded-xl border border-surface-800 bg-surface-900 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-heading text-white">New draw</div>
          <p className="mt-0.5 text-2xs text-slate-500">
            Creates a DRAFT billing request. Nothing is emitted until you issue it.
          </p>
        </div>
        <button
          type="button"
          onClick={close}
          className="rounded-md p-1 text-slate-500 hover:bg-surface-850 hover:text-slate-300"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-2xs uppercase tracking-wider text-slate-500">Job</span>
          <select
            value={jobId}
            onChange={(e) => setJobId(e.target.value)}
            className="w-full rounded-lg border border-surface-800 bg-surface-950 px-3 py-2 text-sm text-white focus:border-brand-500/50 focus:outline-none"
          >
            <option value="">Select a job…</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.jobNumber} · {j.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-2xs uppercase tracking-wider text-slate-500">Type</span>
          <select
            value={billingType}
            onChange={(e) => setBillingType(e.target.value as BillingType)}
            className="w-full rounded-lg border border-surface-800 bg-surface-950 px-3 py-2 text-sm text-white focus:border-brand-500/50 focus:outline-none"
          >
            {BILLING_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-2xs uppercase tracking-wider text-slate-500">Date</span>
          <input
            type="date"
            value={occurredOn}
            onChange={(e) => setOccurredOn(e.target.value)}
            className="num w-full rounded-lg border border-surface-800 bg-surface-950 px-3 py-2 text-sm text-white focus:border-brand-500/50 focus:outline-none"
          />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-2xs uppercase tracking-wider text-slate-500">
            Memo <span className="text-slate-600">(optional)</span>
          </span>
          <input
            type="text"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            maxLength={1000}
            placeholder="Internal note"
            className="w-full rounded-lg border border-surface-800 bg-surface-950 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-brand-500/50 focus:outline-none"
          />
        </label>
      </div>

      {/* Lines */}
      <div className="mt-5">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-2xs uppercase tracking-wider text-slate-500">Lines</span>
          <button
            type="button"
            onClick={() => setLines((prev) => [...prev, newLine()])}
            className="inline-flex items-center gap-1 text-2xs font-medium text-brand-300 hover:text-brand-200"
          >
            <Plus className="h-3.5 w-3.5" />
            Add line
          </button>
        </div>

        <div className="space-y-2">
          {lines.map((line) => {
            const cents = parseDollarsToCents(line.amount);
            return (
              <div key={line.key} className="flex items-center gap-2">
                <input
                  type="text"
                  value={line.description}
                  onChange={(e) => updateLine(line.key, { description: e.target.value })}
                  placeholder="Description"
                  maxLength={500}
                  className="flex-1 rounded-lg border border-surface-800 bg-surface-950 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-brand-500/50 focus:outline-none"
                />
                <div className="relative w-40">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">
                    $
                  </span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={line.amount}
                    onChange={(e) => updateLine(line.key, { amount: e.target.value })}
                    placeholder="0.00"
                    className={clsx(
                      'num w-full rounded-lg border bg-surface-950 py-2 pl-6 pr-3 text-right text-sm text-white placeholder:text-slate-600 focus:outline-none',
                      cents !== null && cents <= 0
                        ? 'border-danger/50 focus:border-danger/60'
                        : 'border-surface-800 focus:border-brand-500/50',
                    )}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => removeLine(line.key)}
                  disabled={lines.length === 1}
                  className={clsx(
                    'rounded-md p-2 transition-colors',
                    lines.length === 1
                      ? 'cursor-not-allowed text-slate-700'
                      : 'text-slate-500 hover:bg-danger/10 hover:text-danger-fg',
                  )}
                  aria-label="Remove line"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </div>

        <div className="mt-3 flex items-center justify-between border-t border-surface-800 pt-3">
          <span className="text-2xs uppercase tracking-wider text-slate-500">Total</span>
          <span className="num text-sm font-semibold text-white">{usdExact(totalCents)}</span>
        </div>
      </div>

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger-fg" />
          <span className="text-sm text-danger-fg">{error}</span>
        </div>
      )}

      <div className="mt-5 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={close}
          className="rounded-lg border border-surface-800 px-3.5 py-2 text-sm font-medium text-slate-300 hover:bg-surface-850"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={submitting || validationError !== null}
          className={clsx(
            'inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors',
            submitting || validationError !== null
              ? 'cursor-not-allowed bg-surface-800 text-slate-500'
              : 'bg-brand-500 text-surface-950 hover:bg-brand-400',
          )}
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          {submitting ? 'Creating…' : 'Create draft'}
        </button>
      </div>
    </div>
  );
}

// ---- Issue draw (two-step inline confirm) ------------------------------------

type IssuePhase = 'idle' | 'armed' | 'submitting' | 'done';
type IssueOutcome = { status: 'EMITTED' | 'UNISSUED' } | { error: string } | null;

const ARM_TIMEOUT_MS = 5000;

export function IssueDraw({ drawId }: { drawId: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<IssuePhase>('idle');
  const [outcome, setOutcome] = useState<IssueOutcome>(null);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (disarmTimer.current) {
      clearTimeout(disarmTimer.current);
      disarmTimer.current = null;
    }
  };

  useEffect(() => () => clearTimer(), []);

  const arm = () => {
    setOutcome(null);
    setPhase('armed');
    clearTimer();
    // Auto-disarm so an armed control never lingers as a hair-trigger.
    disarmTimer.current = setTimeout(() => setPhase('idle'), ARM_TIMEOUT_MS);
  };

  const disarm = () => {
    clearTimer();
    setPhase('idle');
  };

  const fire = async () => {
    clearTimer();
    setPhase('submitting');
    try {
      const res = await fetch(`/api/billing/draws/${drawId}/approve`, { method: 'POST' });
      const payload: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setOutcome({ error: extractError(payload) ?? `Issue failed (${res.status}).` });
        setPhase('idle');
        return;
      }
      const status =
        payload &&
        typeof payload === 'object' &&
        'status' in payload &&
        (payload as { status?: unknown }).status === 'UNISSUED'
          ? 'UNISSUED'
          : 'EMITTED';
      setOutcome({ status });
      setPhase('done');
      // Reflect the new server state (row moves out of DRAFT).
      router.refresh();
    } catch {
      setOutcome({ error: 'Network error — nothing was issued.' });
      setPhase('idle');
    }
  };

  // Terminal display after a successful issue (row will re-render on refresh).
  if (phase === 'done' && outcome && 'status' in outcome) {
    const emitted = outcome.status === 'EMITTED';
    return (
      <span
        className={clsx(
          'inline-flex items-center gap-1.5 text-2xs font-medium',
          emitted ? 'text-info-fg' : 'text-warning-fg',
        )}
      >
        {emitted ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
        {emitted ? 'Emitted' : 'Unissued'}
      </span>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      {phase === 'submitting' ? (
        <span className="inline-flex items-center gap-1.5 rounded-lg border border-surface-800 px-2.5 py-1.5 text-2xs font-medium text-slate-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Issuing…
        </span>
      ) : phase === 'armed' ? (
        <div className="inline-flex items-center gap-1">
          <button
            type="button"
            onClick={fire}
            className="inline-flex items-center gap-1.5 rounded-lg border border-warning/50 bg-warning/10 px-2.5 py-1.5 text-2xs font-semibold text-warning-fg hover:bg-warning/20"
            title="This emits a real JOB_BILLING event"
          >
            <ShieldAlert className="h-3.5 w-3.5" />
            Confirm issue
          </button>
          <button
            type="button"
            onClick={disarm}
            className="rounded-lg border border-surface-800 px-2 py-1.5 text-2xs font-medium text-slate-400 hover:bg-surface-850"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={arm}
          className="inline-flex items-center gap-1.5 rounded-lg border border-brand-500/40 bg-brand-500/10 px-2.5 py-1.5 text-2xs font-medium text-brand-300 hover:bg-brand-500/20"
        >
          <Send className="h-3.5 w-3.5" />
          Issue
        </button>
      )}

      {outcome && 'error' in outcome && (
        <span className="max-w-[16rem] text-right text-2xs leading-tight text-danger-fg">
          {outcome.error}
        </span>
      )}
    </div>
  );
}
