'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  Plus,
  Trash2,
  Loader2,
  CheckCircle2,
  TriangleAlert,
  FilePlus2,
  BadgeCheck,
} from 'lucide-react';
import clsx from 'clsx';

// Client write-paths for the Procurement surface:
//   • NewCommitmentForm — creates a DRAFT PO / subcontract (header + lines) via
//     POST /api/procurement/commitments, then router.refresh().
//   • ApproveButton — approves one DRAFT commitment (mints its PO#/SUB#) via
//     POST /api/procurement/commitments/[id]/approve.
// Money is entered in dollars and converted to integer cents at the boundary.

export interface JobOption {
  id: string;
  job_number: string | null;
  name: string | null;
  status: string | null;
}
export interface VendorOption {
  id: string;
  name: string;
}
export interface CostCodeOption {
  id: string;
  code: string;
  name: string;
  job_id: string | null;
}

type CommitmentType = 'PURCHASE_ORDER' | 'SUBCONTRACT';

interface LineDraft {
  key: string;
  description: string;
  amount: string; // dollars, as typed
  costCodeId: string; // '' = none
}

const usd = (cents: number): string =>
  (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  });

// Parse a dollars string to integer cents; returns null on empty/invalid/≤0.
function dollarsToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

let keySeq = 0;
const newLine = (): LineDraft => ({
  key: `line-${keySeq++}`,
  description: '',
  amount: '',
  costCodeId: '',
});

const fieldClass =
  'w-full rounded-lg border border-surface-800 bg-surface-950 px-3 py-2 text-sm text-white placeholder:text-slate-600 outline-none transition focus:border-brand-500/60 focus:ring-1 focus:ring-brand-500/40 disabled:opacity-50';
const labelClass = 'block text-2xs font-medium uppercase tracking-wider text-slate-500';

export function NewCommitmentForm({
  jobs,
  vendors,
  costCodes,
}: {
  jobs: JobOption[];
  vendors: VendorOption[];
  costCodes: CostCodeOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [jobId, setJobId] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [type, setType] = useState<CommitmentType>('PURCHASE_ORDER');
  const [lines, setLines] = useState<LineDraft[]>([newLine()]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  // Cost codes visible for the chosen job: org-level templates (job_id null) +
  // codes scoped to this job. Empty until a job is picked keeps the list honest.
  const jobCostCodes = useMemo(
    () => costCodes.filter((c) => c.job_id === null || c.job_id === jobId),
    [costCodes, jobId],
  );

  const totalCents = useMemo(
    () => lines.reduce((s, l) => s + (dollarsToCents(l.amount) ?? 0), 0),
    [lines],
  );

  const updateLine = (key: string, patch: Partial<LineDraft>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const removeLine = (key: string) =>
    setLines((prev) => (prev.length === 1 ? prev : prev.filter((l) => l.key !== key)));
  const addLine = () => setLines((prev) => [...prev, newLine()]);

  const reset = () => {
    setJobId('');
    setVendorId('');
    setType('PURCHASE_ORDER');
    setLines([newLine()]);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setOk(false);

    if (!jobId) {
      setError('Pick a job for this commitment.');
      return;
    }
    const payloadLines = lines.map((l) => ({
      description: l.description.trim(),
      amount_cents: dollarsToCents(l.amount),
      cost_code_id: l.costCodeId || null,
    }));
    if (payloadLines.some((l) => !l.description)) {
      setError('Every line needs a description.');
      return;
    }
    if (payloadLines.some((l) => l.amount_cents === null)) {
      setError('Every line needs an amount greater than zero.');
      return;
    }

    setPending(true);
    try {
      const res = await fetch('/api/procurement/commitments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_id: jobId,
          commitment_type: type,
          vendor_id: vendorId || null,
          lines: payloadLines,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Request failed (${res.status})`);
      }
      setOk(true);
      reset();
      router.refresh();
      // Let the success note breathe, then collapse.
      window.setTimeout(() => {
        setOk(false);
        setOpen(false);
      }, 1600);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setPending(false);
    }
  }

  if (!open) {
    return (
      <div className="flex items-center justify-between gap-4 rounded-xl border border-surface-800 bg-surface-900 p-5">
        <div className="flex items-start gap-2.5">
          <FilePlus2 className="mt-0.5 h-4 w-4 text-brand-400" />
          <div>
            <div className="text-heading text-white">New PO / subcontract</div>
            <p className="mt-0.5 text-xs text-slate-500">
              Draft a purchase order or subcontract with cost-coded lines. Approving it mints the number.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={jobs.length === 0}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-surface-950 transition hover:bg-brand-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="h-4 w-4" />
          New commitment
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-xl border border-surface-800 bg-surface-900">
      <div className="flex items-start justify-between gap-4 border-b border-surface-800 p-5">
        <div className="flex items-start gap-2.5">
          <FilePlus2 className="mt-0.5 h-4 w-4 text-brand-400" />
          <div>
            <div className="text-heading text-white">New PO / subcontract</div>
            <p className="mt-0.5 text-xs text-slate-500">
              Creates a DRAFT commitment. Approve it afterward to mint the PO#/SUB#.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={pending}
          className="shrink-0 rounded-lg border border-surface-800 px-3 py-1.5 text-xs text-slate-400 transition hover:bg-surface-950/60 disabled:opacity-50"
        >
          Cancel
        </button>
      </div>

      <div className="space-y-5 p-5">
        {/* Header fields */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5">
            <label htmlFor="pc-job" className={labelClass}>
              Job
            </label>
            <select
              id="pc-job"
              value={jobId}
              onChange={(e) => {
                setJobId(e.target.value);
                // Drop any cost codes that don't belong to the new job.
                setLines((prev) => prev.map((l) => ({ ...l, costCodeId: '' })));
              }}
              disabled={pending}
              className={fieldClass}
            >
              <option value="">Select a job…</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {(j.job_number ?? '—') + ' · ' + (j.name ?? 'Unnamed job')}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="pc-vendor" className={labelClass}>
              Vendor <span className="text-slate-600">(optional)</span>
            </label>
            <select
              id="pc-vendor"
              value={vendorId}
              onChange={(e) => setVendorId(e.target.value)}
              disabled={pending}
              className={fieldClass}
            >
              <option value="">No vendor yet</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <span className={labelClass}>Type</span>
            <div className="flex rounded-lg border border-surface-800 bg-surface-950 p-1">
              {(
                [
                  ['PURCHASE_ORDER', 'Purchase order'],
                  ['SUBCONTRACT', 'Subcontract'],
                ] as const
              ).map(([val, label]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => setType(val)}
                  disabled={pending}
                  className={clsx(
                    'flex-1 rounded-md px-2.5 py-1.5 text-xs font-medium transition',
                    type === val
                      ? 'bg-brand-500/15 text-brand-300 ring-1 ring-inset ring-brand-500/30'
                      : 'text-slate-400 hover:text-slate-200',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Lines */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className={labelClass}>Lines</span>
            <button
              type="button"
              onClick={addLine}
              disabled={pending}
              className="inline-flex items-center gap-1 text-xs font-medium text-brand-400 transition hover:text-brand-300 disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
              Add line
            </button>
          </div>

          <div className="space-y-2">
            {lines.map((l, i) => {
              const cents = dollarsToCents(l.amount);
              return (
                <div
                  key={l.key}
                  className="grid grid-cols-1 gap-2 rounded-lg border border-surface-800 bg-surface-950/40 p-2.5 sm:grid-cols-12"
                >
                  <div className="sm:col-span-6">
                    <input
                      type="text"
                      value={l.description}
                      onChange={(e) => updateLine(l.key, { description: e.target.value })}
                      placeholder={`Line ${i + 1} description`}
                      disabled={pending}
                      className={fieldClass}
                      aria-label={`Line ${i + 1} description`}
                    />
                  </div>
                  <div className="sm:col-span-3">
                    <select
                      value={l.costCodeId}
                      onChange={(e) => updateLine(l.key, { costCodeId: e.target.value })}
                      disabled={pending || !jobId}
                      className={fieldClass}
                      aria-label={`Line ${i + 1} cost code`}
                    >
                      <option value="">Cost code…</option>
                      {jobCostCodes.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.code} · {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="sm:col-span-2">
                    <div className="relative">
                      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">
                        $
                      </span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={l.amount}
                        onChange={(e) => updateLine(l.key, { amount: e.target.value })}
                        placeholder="0.00"
                        disabled={pending}
                        className={clsx(fieldClass, 'num pl-6 text-right')}
                        aria-label={`Line ${i + 1} amount`}
                      />
                    </div>
                  </div>
                  <div className="flex items-center justify-end sm:col-span-1">
                    <button
                      type="button"
                      onClick={() => removeLine(l.key)}
                      disabled={pending || lines.length === 1}
                      className="rounded-md p-2 text-slate-500 transition hover:bg-danger/10 hover:text-danger-fg disabled:cursor-not-allowed disabled:opacity-30"
                      aria-label={`Remove line ${i + 1}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  {l.amount.trim() !== '' && cents === null && (
                    <div className="num text-2xs text-danger-fg sm:col-span-12">
                      Enter an amount greater than zero.
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer: total + submit + status */}
        <div className="flex flex-col gap-3 border-t border-surface-800 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-baseline gap-2">
            <span className="text-2xs uppercase tracking-wider text-slate-500">Commitment total</span>
            <span className="num text-heading font-semibold text-white">{usd(totalCents)}</span>
          </div>
          <div className="flex items-center gap-3">
            {error && (
              <span className="inline-flex items-center gap-1.5 text-xs text-danger-fg">
                <TriangleAlert className="h-3.5 w-3.5" />
                {error}
              </span>
            )}
            {ok && (
              <span className="inline-flex items-center gap-1.5 text-xs text-success-fg">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Draft created
              </span>
            )}
            <button
              type="submit"
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-surface-950 transition hover:bg-brand-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {pending ? 'Creating…' : 'Create draft'}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}

export function ApproveButton({ commitmentId }: { commitmentId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    setError(null);
    setPending(true);
    try {
      const res = await fetch(`/api/procurement/commitments/${commitmentId}/approve`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Request failed (${res.status})`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approval failed.');
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={approve}
        disabled={pending}
        className="inline-flex items-center gap-1.5 rounded-lg border border-brand-500/40 bg-brand-500/10 px-2.5 py-1.5 text-xs font-medium text-brand-300 transition hover:bg-brand-500/20 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BadgeCheck className="h-3.5 w-3.5" />}
        {pending ? 'Approving…' : 'Approve'}
      </button>
      {error && (
        <span className="inline-flex max-w-[12rem] items-center gap-1 text-right text-2xs text-danger-fg">
          <TriangleAlert className="h-3 w-3 shrink-0" />
          {error}
        </span>
      )}
    </div>
  );
}
