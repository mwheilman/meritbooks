'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import {
  Plus,
  X,
  Loader2,
  ArrowRight,
  Check,
  AlertCircle,
  UserRound,
} from 'lucide-react';

// Client write-paths for the G6 dispatch board. Every mutation POSTs/PATCHes an
// RLS-scoped route, then calls router.refresh() so the server board re-renders
// the row into its new lane. No window.confirm/alert — terminal transitions use
// an inline two-step confirm.

export type WorkOrderStatus =
  | 'DRAFT'
  | 'SCHEDULED'
  | 'DISPATCHED'
  | 'IN_PROGRESS'
  | 'ON_HOLD'
  | 'COMPLETED'
  | 'CANCELED';

export interface JobOption {
  id: string;
  job_number: string;
  name: string;
}

export interface EmployeeOption {
  id: string;
  first_name: string;
  last_name: string;
}

const PRIORITY_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: 'Normal' },
  { value: 1, label: 'Elevated' },
  { value: 2, label: 'High' },
  { value: 3, label: 'Urgent' },
];

// Forward flow through the board. Terminal lanes (COMPLETED/CANCELED) have no
// advance target. ON_HOLD resumes into IN_PROGRESS.
const NEXT_STATUS: Record<WorkOrderStatus, { next: WorkOrderStatus; label: string } | null> = {
  DRAFT: { next: 'SCHEDULED', label: 'Schedule' },
  SCHEDULED: { next: 'DISPATCHED', label: 'Dispatch' },
  DISPATCHED: { next: 'IN_PROGRESS', label: 'Start' },
  IN_PROGRESS: { next: 'COMPLETED', label: 'Complete' },
  ON_HOLD: { next: 'IN_PROGRESS', label: 'Resume' },
  COMPLETED: null,
  CANCELED: null,
};

function employeeName(e: EmployeeOption): string {
  return `${e.first_name} ${e.last_name}`.trim();
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      error?: string;
      details?: Record<string, string[]>;
    };
    if (body.details) {
      const first = Object.values(body.details)[0];
      if (first && first.length > 0) return first[0];
    }
    if (body.error) return body.error;
  } catch {
    /* fall through to status text */
  }
  return `Request failed (${res.status})`;
}

// ---------------------------------------------------------------------------
// New work order — header button + inline modal form
// ---------------------------------------------------------------------------

export function NewWorkOrderButton({ jobs }: { jobs: JobOption[] }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-brand-800 bg-brand-500/10 px-3 py-1.5 text-sm font-medium text-brand-300 transition-colors hover:bg-brand-500/20"
      >
        <Plus className="h-4 w-4" />
        New work order
      </button>
      {open && <NewWorkOrderModal jobs={jobs} onClose={() => setOpen(false)} />}
    </>
  );
}

function NewWorkOrderModal({ jobs, onClose }: { jobs: JobOption[]; onClose: () => void }) {
  const router = useRouter();
  const [jobId, setJobId] = useState('');
  const [title, setTitle] = useState('');
  const [capability, setCapability] = useState('');
  const [zone, setZone] = useState('');
  const [priority, setPriority] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = jobId !== '' && title.trim() !== '' && !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/schedule/work-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_id: jobId,
          title: title.trim(),
          required_capability: capability.trim() || undefined,
          zone: zone.trim() || undefined,
          priority,
        }),
      });
      if (!res.ok) {
        setError(await readError(res));
        setSubmitting(false);
        return;
      }
      onClose();
      router.refresh();
    } catch {
      setError('Network error — please try again.');
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-surface-950/80 p-4 pt-20 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="New work order"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md space-y-4 rounded-xl border border-surface-800 bg-surface-900 p-5 shadow-2xl"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-heading font-semibold text-white">New work order</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-slate-500 transition-colors hover:bg-surface-800 hover:text-slate-300"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <Field label="Job" required>
          {jobs.length === 0 ? (
            <p className="text-2xs text-slate-500">
              No active jobs available. Create or activate a job first.
            </p>
          ) : (
            <select
              value={jobId}
              onChange={(e) => setJobId(e.target.value)}
              required
              className={selectClass}
            >
              <option value="">Select a job…</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  #{j.job_number} — {j.name}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field label="Title" required>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={200}
            placeholder="e.g. Rough-in second floor"
            className={inputClass}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Required capability">
            <input
              type="text"
              value={capability}
              onChange={(e) => setCapability(e.target.value)}
              maxLength={120}
              placeholder="e.g. HVAC"
              className={inputClass}
            />
          </Field>
          <Field label="Zone">
            <input
              type="text"
              value={zone}
              onChange={(e) => setZone(e.target.value)}
              maxLength={120}
              placeholder="e.g. North"
              className={inputClass}
            />
          </Field>
        </div>

        <Field label="Priority">
          <select
            value={priority}
            onChange={(e) => setPriority(Number(e.target.value))}
            className={selectClass}
          >
            {PRIORITY_OPTIONS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-2xs text-danger-fg">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-surface-800 px-3 py-1.5 text-sm text-slate-300 transition-colors hover:bg-surface-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex items-center gap-1.5 rounded-lg border border-brand-700 bg-brand-500/15 px-3 py-1.5 text-sm font-medium text-brand-300 transition-colors hover:bg-brand-500/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Create work order
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-card controls — status advance + assignment
// ---------------------------------------------------------------------------

export function WorkOrderControls({
  id,
  status,
  assignedEmployeeId,
  employees,
}: {
  id: string;
  status: WorkOrderStatus;
  assignedEmployeeId: string | null;
  employees: EmployeeOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const working = busy || pending;
  const advance = NEXT_STATUS[status];
  const isTerminalAdvance = advance?.next === 'COMPLETED';

  async function patch(payload: {
    status?: WorkOrderStatus;
    assigned_employee_id?: string | null;
  }) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/schedule/work-orders/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...payload }),
      });
      if (!res.ok) {
        setError(await readError(res));
        setBusy(false);
        return;
      }
      setBusy(false);
      startTransition(() => router.refresh());
    } catch {
      setError('Network error');
      setBusy(false);
    }
  }

  function onAdvanceClick() {
    if (!advance) return;
    if (isTerminalAdvance && !confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    void patch({ status: advance.next });
  }

  return (
    <div className="mt-2.5 space-y-2 border-t border-surface-900 pt-2.5">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <UserRound className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-500" />
          <select
            value={assignedEmployeeId ?? ''}
            disabled={working || employees.length === 0}
            onChange={(e) =>
              void patch({ assigned_employee_id: e.target.value === '' ? null : e.target.value })
            }
            aria-label="Assign employee"
            className="w-full appearance-none rounded-md border border-surface-800 bg-surface-900 py-1 pl-6 pr-2 text-2xs text-slate-300 transition-colors hover:border-surface-800 focus:border-brand-700 focus:outline-none disabled:opacity-50"
          >
            <option value="">Unassigned</option>
            {employees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {employeeName(emp)}
              </option>
            ))}
          </select>
        </div>

        {advance &&
          (confirming ? (
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={onAdvanceClick}
                disabled={working}
                className="inline-flex items-center gap-1 rounded-md border border-brand-700 bg-brand-500/15 px-2 py-1 text-2xs font-semibold text-brand-300 transition-colors hover:bg-brand-500/25 disabled:opacity-40"
              >
                {working ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Check className="h-3 w-3" />
                )}
                Confirm
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={working}
                className="rounded-md border border-surface-800 px-1.5 py-1 text-2xs text-slate-400 transition-colors hover:bg-surface-800 disabled:opacity-40"
                aria-label="Cancel"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={onAdvanceClick}
              disabled={working}
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-surface-800 bg-surface-950 px-2 py-1 text-2xs font-semibold text-slate-300 transition-colors hover:border-brand-800 hover:text-brand-200 disabled:opacity-40"
            >
              {working ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <ArrowRight className="h-3 w-3" />
              )}
              {advance.label}
            </button>
          ))}
      </div>

      {error && (
        <div className="flex items-center gap-1 text-2xs text-danger-fg">
          <AlertCircle className="h-3 w-3 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared field / input styling
// ---------------------------------------------------------------------------

const inputClass =
  'w-full rounded-lg border border-surface-800 bg-surface-950 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-brand-700 focus:outline-none';
const selectClass =
  'w-full rounded-lg border border-surface-800 bg-surface-950 px-3 py-2 text-sm text-white focus:border-brand-700 focus:outline-none';

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-2xs font-medium uppercase tracking-wider text-slate-400">
        {label}
        {required && <span className="text-danger-fg"> *</span>}
      </span>
      {children}
    </label>
  );
}
