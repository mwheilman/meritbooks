'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import {
  Plus,
  X,
  Loader2,
  AlertTriangle,
  PencilLine,
  Lock,
  Unlock,
  Check,
} from 'lucide-react';

// Client actions for the Allowances page:
//   AddAllowance        — create an OPEN allowance (POST /api/allowances).
//   AllowanceRowActions — record a drawdown (PATCH consumedCents, an ABSOLUTE
//                         consumed-to-date figure) and open/close the allowance
//                         (PATCH status). Both guard ('proj_contracts','edit')
//                         server-side.

export interface CostCodeOption {
  id: string;
  label: string;
}

const usdExact = (cents: number): string =>
  (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

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

// ── Add allowance ────────────────────────────────────────────────────────────

export function AddAllowance({
  jobId,
  costCodes,
}: {
  jobId: string;
  costCodes: CostCodeOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [costCodeId, setCostCodeId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allowanceCents = useMemo(() => parseDollarsToCents(amount), [amount]);

  const validationError = useMemo((): string | null => {
    if (!description.trim()) return 'Enter a description.';
    if (allowanceCents === null) return 'Enter an allowance amount.';
    if (allowanceCents < 0) return 'Amount must be 0 or greater.';
    return null;
  }, [description, allowanceCents]);

  const reset = () => {
    setDescription('');
    setAmount('');
    setCostCodeId('');
    setError(null);
    setSubmitting(false);
  };

  const close = () => {
    setOpen(false);
    reset();
  };

  const submit = async () => {
    if (validationError || allowanceCents === null) {
      setError(validationError);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/allowances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId,
          description: description.trim(),
          allowanceCents,
          costCodeId: costCodeId ? costCodeId : undefined,
        }),
      });
      const payload: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setError(extractError(payload) ?? `Failed to add allowance (${res.status}).`);
        setSubmitting(false);
        return;
      }
      close();
      router.refresh();
    } catch {
      setError('Network error — the allowance was not created.');
      setSubmitting(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-lg border border-brand-500/40 bg-brand-500/10 px-3.5 py-2 text-sm font-medium text-brand-300 transition-colors hover:bg-brand-500/20"
      >
        <Plus className="h-4 w-4" />
        Add allowance
      </button>
    );
  }

  return (
    <div className="w-full rounded-xl border border-surface-800 bg-surface-900 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-heading text-white">New allowance</div>
          <p className="mt-0.5 text-2xs text-slate-500">
            A budgeted owner allowance, drawn down as selections are made.
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

      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <label className="block sm:col-span-1">
          <span className="mb-1.5 block text-2xs uppercase tracking-wider text-slate-500">
            Description
          </span>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            placeholder="Lighting allowance"
            className="w-full rounded-lg border border-surface-800 bg-surface-950 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-brand-500/50 focus:outline-none"
          />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-2xs uppercase tracking-wider text-slate-500">
            Allowance
          </span>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">
              $
            </span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="num w-full rounded-lg border border-surface-800 bg-surface-950 py-2 pl-6 pr-3 text-right text-sm text-white placeholder:text-slate-600 focus:border-brand-500/50 focus:outline-none"
            />
          </div>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-2xs uppercase tracking-wider text-slate-500">
            Cost code <span className="text-slate-600">(optional)</span>
          </span>
          <select
            value={costCodeId}
            onChange={(e) => setCostCodeId(e.target.value)}
            disabled={costCodes.length === 0}
            className="w-full rounded-lg border border-surface-800 bg-surface-950 px-3 py-2 text-sm text-white focus:border-brand-500/50 focus:outline-none disabled:opacity-50"
          >
            <option value="">
              {costCodes.length === 0 ? 'No cost codes' : 'None'}
            </option>
            {costCodes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
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
          {submitting ? 'Adding…' : 'Add allowance'}
        </button>
      </div>
    </div>
  );
}

// ── Row actions: record drawdown + open/close ────────────────────────────────

type CloseState = 'idle' | 'armed' | 'submitting';

export function AllowanceRowActions({
  allowanceId,
  status,
  consumedCents,
  allowanceCents,
}: {
  allowanceId: string;
  status: 'OPEN' | 'CLOSED';
  consumedCents: number;
  allowanceCents: number;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [consumed, setConsumed] = useState((consumedCents / 100).toFixed(2));
  const [savingDraw, setSavingDraw] = useState(false);
  const [drawError, setDrawError] = useState<string | null>(null);

  const [closePhase, setClosePhase] = useState<CloseState>('idle');
  const [closeError, setCloseError] = useState<string | null>(null);

  const consumedCentsParsed = useMemo(() => parseDollarsToCents(consumed), [consumed]);

  const drawValidation = useMemo((): string | null => {
    if (consumedCentsParsed === null) return 'Enter a consumed amount.';
    if (consumedCentsParsed < 0) return 'Amount must be 0 or greater.';
    return null;
  }, [consumedCentsParsed]);

  const willOverrun =
    consumedCentsParsed !== null && allowanceCents > 0 && consumedCentsParsed > allowanceCents;

  const saveDrawdown = async () => {
    if (drawValidation || consumedCentsParsed === null) {
      setDrawError(drawValidation);
      return;
    }
    setSavingDraw(true);
    setDrawError(null);
    try {
      const res = await fetch(`/api/allowances/${allowanceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consumedCents: consumedCentsParsed }),
      });
      const payload: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setDrawError(extractError(payload) ?? `Failed to record drawdown (${res.status}).`);
        setSavingDraw(false);
        return;
      }
      setEditing(false);
      setSavingDraw(false);
      router.refresh();
    } catch {
      setDrawError('Network error — the drawdown was not recorded.');
      setSavingDraw(false);
    }
  };

  const setStatus = async (next: 'OPEN' | 'CLOSED') => {
    setClosePhase('submitting');
    setCloseError(null);
    try {
      const res = await fetch(`/api/allowances/${allowanceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      const payload: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setCloseError(extractError(payload) ?? `Failed to update (${res.status}).`);
        setClosePhase('idle');
        return;
      }
      setClosePhase('idle');
      router.refresh();
    } catch {
      setCloseError('Network error.');
      setClosePhase('idle');
    }
  };

  const closed = status === 'CLOSED';

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-1.5">
        {!closed && !editing && (
          <button
            type="button"
            onClick={() => {
              setConsumed((consumedCents / 100).toFixed(2));
              setDrawError(null);
              setEditing(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-surface-800 px-2.5 py-1.5 text-2xs font-medium text-slate-300 hover:bg-surface-850"
          >
            <PencilLine className="h-3.5 w-3.5" />
            Record drawdown
          </button>
        )}

        {closed ? (
          closePhase === 'submitting' ? (
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-surface-800 px-2.5 py-1.5 text-2xs text-slate-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reopening…
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setStatus('OPEN')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-surface-800 px-2.5 py-1.5 text-2xs font-medium text-slate-300 hover:bg-surface-850"
            >
              <Unlock className="h-3.5 w-3.5" />
              Reopen
            </button>
          )
        ) : closePhase === 'submitting' ? (
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-surface-800 px-2.5 py-1.5 text-2xs text-slate-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Closing…
          </span>
        ) : closePhase === 'armed' ? (
          <div className="inline-flex items-center gap-1">
            <button
              type="button"
              onClick={() => setStatus('CLOSED')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-warning/50 bg-warning/10 px-2.5 py-1.5 text-2xs font-semibold text-warning-fg hover:bg-warning/20"
            >
              <Check className="h-3.5 w-3.5" />
              Confirm close
            </button>
            <button
              type="button"
              onClick={() => setClosePhase('idle')}
              className="rounded-lg border border-surface-800 px-2 py-1.5 text-2xs font-medium text-slate-400 hover:bg-surface-850"
            >
              Cancel
            </button>
          </div>
        ) : (
          !editing && (
            <button
              type="button"
              onClick={() => setClosePhase('armed')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-surface-800 px-2.5 py-1.5 text-2xs font-medium text-slate-400 hover:bg-surface-850"
            >
              <Lock className="h-3.5 w-3.5" />
              Close
            </button>
          )
        )}
      </div>

      {editing && (
        <div className="flex flex-col items-end gap-1.5 rounded-lg border border-surface-800 bg-surface-950 p-3">
          <div className="flex items-center gap-2">
            <label className="text-2xs uppercase tracking-wider text-slate-500">
              Consumed to date
            </label>
            <div className="relative w-36">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">
                $
              </span>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={consumed}
                onChange={(e) => setConsumed(e.target.value)}
                className="num w-full rounded-lg border border-surface-800 bg-surface-900 py-1.5 pl-6 pr-3 text-right text-sm text-white focus:border-brand-500/50 focus:outline-none"
              />
            </div>
            <button
              type="button"
              onClick={saveDrawdown}
              disabled={savingDraw || drawValidation !== null}
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-2xs font-medium transition-colors',
                savingDraw || drawValidation !== null
                  ? 'cursor-not-allowed bg-surface-800 text-slate-500'
                  : 'bg-brand-500 text-surface-950 hover:bg-brand-400',
              )}
            >
              {savingDraw ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setDrawError(null);
              }}
              className="rounded-lg border border-surface-800 px-2 py-1.5 text-2xs font-medium text-slate-400 hover:bg-surface-850"
            >
              Cancel
            </button>
          </div>
          <p className="text-2xs text-slate-600">
            Absolute total consumed (not a delta). Currently {usdExact(consumedCents)}.
          </p>
          {willOverrun && !drawError && (
            <p className="text-2xs text-warning-fg">This exceeds the allowance — an overrun.</p>
          )}
          {drawError && <p className="text-2xs text-danger-fg">{drawError}</p>}
        </div>
      )}

      {closeError && <p className="text-2xs text-danger-fg">{closeError}</p>}
    </div>
  );
}
