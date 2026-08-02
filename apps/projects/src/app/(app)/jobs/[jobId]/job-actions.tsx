'use client';

import { useState, useTransition, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, X, Loader2, AlertCircle, ChevronRight } from 'lucide-react';
import clsx from 'clsx';

// Client action surfaces for the Job detail page: create cost codes, create
// external gates, and advance a gate through its (server-enforced) state
// machine. Every write hits an RLS-scoped API route; on success we
// router.refresh() so the server-rendered page re-queries live data.

const COST_TYPES = ['LABOR', 'MATERIALS', 'SUBCONTRACTOR', 'EQUIPMENT', 'OTHER'] as const;
type CostType = (typeof COST_TYPES)[number];

const GATE_TYPES = [
  'PERMIT',
  'PTO',
  'INSPECTION',
  'CERTIFICATE_OF_OCCUPANCY',
  'UTILITY_INTERCONNECT',
  'FINAL_ACCEPTANCE',
  'OTHER',
] as const;
type GateType = (typeof GATE_TYPES)[number];

const GATE_STATUSES = [
  'PENDING',
  'SUBMITTED',
  'APPROVED',
  'CLEARED',
  'REJECTED',
  'EXPIRED',
  'WAIVED',
] as const;
export type GateStatus = (typeof GATE_STATUSES)[number];

// Legal next statuses — mirrors proj.advance_external_gate. CLEARED/WAIVED terminal.
const NEXT_STATUS: Record<GateStatus, readonly GateStatus[]> = {
  PENDING: ['SUBMITTED', 'WAIVED'],
  SUBMITTED: ['APPROVED', 'REJECTED', 'WAIVED'],
  APPROVED: ['CLEARED', 'EXPIRED', 'REJECTED'],
  REJECTED: ['SUBMITTED'],
  EXPIRED: ['SUBMITTED'],
  CLEARED: [],
  WAIVED: [],
};

// Tone per target status so advance buttons read as intent (advance vs reject/expire).
const STATUS_ACTION_TONE: Record<GateStatus, string> = {
  PENDING: 'border-surface-800 text-slate-300 hover:bg-surface-800',
  SUBMITTED: 'border-info/30 text-info-fg hover:bg-info/10',
  APPROVED: 'border-brand-500/30 text-brand-300 hover:bg-brand-500/10',
  CLEARED: 'border-brand-500/30 text-brand-300 hover:bg-brand-500/10',
  WAIVED: 'border-surface-800 text-slate-400 hover:bg-surface-800',
  REJECTED: 'border-danger/30 text-danger-fg hover:bg-danger/10',
  EXPIRED: 'border-danger/30 text-danger-fg hover:bg-danger/10',
};

const humanize = (s: string): string => s.replace(/_/g, ' ').toLowerCase();

const FIELD_CLS =
  'w-full rounded-md border border-surface-800 bg-surface-950 px-2.5 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500/40';
const LABEL_CLS = 'block text-2xs font-medium uppercase tracking-wider text-slate-500';
const PRIMARY_BTN =
  'inline-flex items-center justify-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50';
const GHOST_BTN =
  'inline-flex items-center gap-1.5 rounded-md border border-surface-800 bg-surface-950 px-2.5 py-1.5 text-sm font-medium text-slate-300 transition-colors hover:bg-surface-800';

async function readError(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as {
      error?: string;
      details?: Record<string, string[]>;
    };
    if (j.details) {
      const first = Object.values(j.details)[0];
      if (first && first[0]) return first[0];
    }
    return j.error ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

function ErrorNote({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-1.5 rounded-md border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-2xs text-danger-fg"
    >
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

// Collapsible "Add X" affordance wrapping an inline form.
function Disclosure({
  label,
  children,
}: {
  label: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" className={GHOST_BTN} onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" />
        {label}
      </button>
    );
  }
  return (
    <div className="rounded-lg border border-surface-800 bg-surface-950 p-3">
      <div className="mb-2.5 flex items-center justify-between">
        <span className="text-2xs font-medium uppercase tracking-wider text-slate-400">{label}</span>
        <button
          type="button"
          aria-label="Cancel"
          className="text-slate-500 hover:text-slate-300"
          onClick={() => setOpen(false)}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {children(() => setOpen(false))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// (a) Add cost code
// ---------------------------------------------------------------------------
export function AddCostCode({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [costType, setCostType] = useState<CostType | ''>('');

  return (
    <Disclosure label="Add cost code">
      {(close) => {
        const onSubmit = async (e: FormEvent) => {
          e.preventDefault();
          setError(null);
          setBusy(true);
          try {
            const res = await fetch(`/api/jobs/${jobId}/cost-codes`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                code: code.trim(),
                name: name.trim(),
                ...(costType ? { cost_type: costType } : {}),
              }),
            });
            if (!res.ok) {
              setError(await readError(res));
              return;
            }
            setCode('');
            setName('');
            setCostType('');
            close();
            startTransition(() => router.refresh());
          } catch {
            setError('Network error — please try again.');
          } finally {
            setBusy(false);
          }
        };

        const working = busy || pending;
        return (
          <form onSubmit={onSubmit} className="space-y-2.5">
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <label className="space-y-1">
                <span className={LABEL_CLS}>Code</span>
                <input
                  className={FIELD_CLS}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="03 30 00"
                  required
                  disabled={working}
                />
              </label>
              <label className="space-y-1">
                <span className={LABEL_CLS}>Name</span>
                <input
                  className={FIELD_CLS}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Cast-in-place concrete"
                  required
                  disabled={working}
                />
              </label>
            </div>
            <label className="space-y-1">
              <span className={LABEL_CLS}>Cost type (optional)</span>
              <select
                className={FIELD_CLS}
                value={costType}
                onChange={(e) => setCostType(e.target.value as CostType | '')}
                disabled={working}
              >
                <option value="">—</option>
                {COST_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {humanize(t)}
                  </option>
                ))}
              </select>
            </label>
            {error && <ErrorNote message={error} />}
            <div className="flex items-center gap-2">
              <button type="submit" className={PRIMARY_BTN} disabled={working || !code.trim() || !name.trim()}>
                {working && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Add cost code
              </button>
            </div>
          </form>
        );
      }}
    </Disclosure>
  );
}

// ---------------------------------------------------------------------------
// (b) Add gate
// ---------------------------------------------------------------------------
export function AddGate({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gateType, setGateType] = useState<GateType>('PERMIT');
  const [name, setName] = useState('');

  return (
    <Disclosure label="Add gate">
      {(close) => {
        const onSubmit = async (e: FormEvent) => {
          e.preventDefault();
          setError(null);
          setBusy(true);
          try {
            const res = await fetch('/api/gates', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ job_id: jobId, gate_type: gateType, name: name.trim() }),
            });
            if (!res.ok) {
              setError(await readError(res));
              return;
            }
            setName('');
            setGateType('PERMIT');
            close();
            startTransition(() => router.refresh());
          } catch {
            setError('Network error — please try again.');
          } finally {
            setBusy(false);
          }
        };

        const working = busy || pending;
        return (
          <form onSubmit={onSubmit} className="space-y-2.5">
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <label className="space-y-1">
                <span className={LABEL_CLS}>Gate type</span>
                <select
                  className={FIELD_CLS}
                  value={gateType}
                  onChange={(e) => setGateType(e.target.value as GateType)}
                  disabled={working}
                >
                  {GATE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {humanize(t)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className={LABEL_CLS}>Name</span>
                <input
                  className={FIELD_CLS}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Building permit #"
                  required
                  disabled={working}
                />
              </label>
            </div>
            {error && <ErrorNote message={error} />}
            <button type="submit" className={PRIMARY_BTN} disabled={working || !name.trim()}>
              {working && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Add gate
            </button>
          </form>
        );
      }}
    </Disclosure>
  );
}

// ---------------------------------------------------------------------------
// (c) Per-gate advance control — offers only legal next statuses
// ---------------------------------------------------------------------------
export function GateAdvance({ gateId, status }: { gateId: string; status: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<GateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const current = (GATE_STATUSES as readonly string[]).includes(status)
    ? (status as GateStatus)
    : null;
  const options = current ? NEXT_STATUS[current] : [];

  if (options.length === 0) {
    return <span className="text-2xs text-slate-600">Terminal — no further transitions</span>;
  }

  const advance = async (next: GateStatus) => {
    setError(null);
    setBusy(next);
    try {
      const res = await fetch(`/api/gates/${gateId}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_status: next }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError('Network error — please try again.');
    } finally {
      setBusy(null);
    }
  };

  const working = busy !== null || pending;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {options.map((next) => (
          <button
            key={next}
            type="button"
            onClick={() => void advance(next)}
            disabled={working}
            className={clsx(
              'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-2xs font-medium uppercase tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              STATUS_ACTION_TONE[next],
            )}
          >
            {busy === next ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            {humanize(next)}
          </button>
        ))}
      </div>
      {error && <ErrorNote message={error} />}
    </div>
  );
}
