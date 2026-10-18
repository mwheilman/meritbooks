'use client';

import { useEffect, useMemo, useState } from 'react';
import { clsx } from 'clsx';
import {
  Sparkles,
  Loader2,
  AlertCircle,
  Search,
  DollarSign,
  TrendingDown,
  Layers,
  Plus,
  Play,
  X,
} from 'lucide-react';
import { formatMoney, dollarsToCents } from '@meritbooks/shared';
import { useQuery, useMutation, useToast, addToast } from '@/hooks';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { isSpecificCompany } from '@/lib/company-scope';
import { MetricCard, EmptyState, ToastContainer } from '@/components/ui';
import {
  INTANGIBLE_CATEGORIES,
  INTANGIBLE_CATEGORY_LABELS,
  isNonAmortizing,
  type IntangibleCategory,
} from '@/lib/intangibles/categories';

interface IntangibleRow {
  id: string;
  name: string;
  description: string | null;
  category: string;
  acquisitionDate: string;
  acquisitionCostCents: number;
  salvageValueCents: number;
  usefulLifeMonths: number;
  depreciationMethod: string;
  accumulatedAmortizationCents: number;
  netBookValueCents: number;
  lastAmortizationDate: string | null;
  remainingLifeMonths: number | null;
  amortizing: boolean;
  status: string;
  locationId: string;
}

interface IntangiblesResponse {
  data: IntangibleRow[];
  summary: {
    count: number;
    totalCostCents: number;
    totalAccumAmortizationCents: number;
    totalNBVCents: number;
    goodwillCount: number;
    byStatus: Record<string, number>;
  };
}

interface LocationOption {
  id: string;
  name: string;
}

const STATUS_CLS: Record<string, string> = {
  ACTIVE: 'bg-emerald-500/10 text-emerald-400',
  FULLY_DEPRECIATED: 'bg-amber-500/10 text-amber-400',
  DISPOSED: 'bg-slate-500/10 text-slate-500',
  IMPAIRED: 'bg-red-500/10 text-red-400',
};

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Amortizing',
  FULLY_DEPRECIATED: 'Fully amortized',
  DISPOSED: 'Disposed',
  IMPAIRED: 'Impaired',
};

function labelFor(category: string): string {
  return INTANGIBLE_CATEGORY_LABELS[category as IntangibleCategory] ?? category.replace('INTANGIBLE_', '');
}

function remainingLifeLabel(row: IntangibleRow): string {
  if (!row.amortizing) return 'Indefinite';
  if (row.remainingLifeMonths === null) return '—';
  if (row.remainingLifeMonths === 0) return 'Complete';
  const yrs = Math.floor(row.remainingLifeMonths / 12);
  const mos = row.remainingLifeMonths % 12;
  return yrs > 0 ? `${yrs}y ${mos}m` : `${mos}m`;
}

export function IntangiblesView() {
  useToast();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  const params: Record<string, string> = {};
  if (statusFilter) params.status = statusFilter;
  const { data, isLoading, error, refetch } = useQuery<IntangiblesResponse>(
    '/api/intangibles',
    Object.keys(params).length ? params : undefined,
  );

  const amortize = useMutation<{ asOf?: string }, { ok: boolean; periods_posted: number; amount_posted_cents: number; skipped: unknown[] }>(
    '/api/intangibles/amortize',
  );

  const rows = data?.data ?? [];
  const summary = data?.summary;

  const filtered = useMemo(
    () =>
      search
        ? rows.filter(
            (r) =>
              r.name.toLowerCase().includes(search.toLowerCase()) ||
              labelFor(r.category).toLowerCase().includes(search.toLowerCase()),
          )
        : rows,
    [rows, search],
  );

  async function runAmortization() {
    const res = await amortize.mutate({});
    if (res?.ok) {
      addToast(
        'success',
        res.periods_posted > 0
          ? `Posted ${res.periods_posted} period(s) — ${formatMoney(res.amount_posted_cents)} amortized`
          : 'Amortization up to date — nothing due to post',
      );
      await refetch();
    } else if (amortize.error) {
      addToast('error', amortize.error);
    }
  }

  async function impair(row: IntangibleRow) {
    const input = window.prompt(
      `Impairment write-down for "${row.name}" (net book value ${formatMoney(row.netBookValueCents)}).\nEnter the write-down amount in dollars:`,
    );
    if (!input) return;
    const dollars = Number(input);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      addToast('error', 'Enter a positive dollar amount');
      return;
    }
    const amountCents = dollarsToCents(dollars);
    const resp = await fetch('/api/intangibles/impair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetId: row.id, amountCents }),
    });
    const body = (await resp.json().catch(() => ({}))) as { error?: string; entryNumber?: string };
    if (resp.ok) {
      addToast('success', `Impairment posted${body.entryNumber ? ` (JE ${body.entryNumber})` : ''}`);
      await refetch();
    } else {
      addToast('error', body.error ?? 'Impairment failed');
    }
  }

  return (
    <div className="space-y-6">
      <ToastContainer />

      {/* Summary */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Intangibles" value={summary ? String(summary.count) : '—'} icon={Layers} />
        <MetricCard label="Gross cost" value={summary ? formatMoney(summary.totalCostCents) : '—'} icon={DollarSign} />
        <MetricCard
          label="Accumulated amortization"
          value={summary ? formatMoney(summary.totalAccumAmortizationCents) : '—'}
          icon={TrendingDown}
        />
        <MetricCard label="Net book value" value={summary ? formatMoney(summary.totalNBVCents) : '—'} icon={Sparkles} />
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search intangibles…"
            className="w-full rounded-lg border border-slate-800 bg-surface-950 py-2 pl-9 pr-3 text-sm text-white placeholder:text-slate-500 focus:border-emerald-500/50 focus:outline-none"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-lg border border-slate-800 bg-surface-950 px-3 py-2 text-sm text-white focus:border-emerald-500/50 focus:outline-none"
        >
          <option value="">All statuses</option>
          <option value="ACTIVE">Amortizing</option>
          <option value="FULLY_DEPRECIATED">Fully amortized</option>
          <option value="IMPAIRED">Impaired</option>
          <option value="DISPOSED">Disposed</option>
        </select>
        <button
          onClick={runAmortization}
          disabled={amortize.isLoading}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-800 bg-surface-900 px-3 py-2 text-sm font-medium text-slate-200 hover:border-emerald-500/40 disabled:opacity-50"
        >
          {amortize.isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          Record amortization
        </button>
        <button
          onClick={() => setCreateOpen(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-400"
        >
          <Plus className="h-4 w-4" />
          New intangible
        </button>
      </div>

      {/* States */}
      {isLoading ? (
        <div className="flex items-center justify-center py-20 text-slate-400">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading intangibles…
        </div>
      ) : error ? (
        <div className="flex items-center gap-3 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-6 text-sm text-red-300">
          <AlertCircle className="h-5 w-5" /> {error}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title={rows.length === 0 ? 'No intangible assets yet' : 'No matches'}
          description={
            rows.length === 0
              ? 'Add software, patents, licenses, customer lists or goodwill to start the amortization schedule.'
              : 'Try a different search or status filter.'
          }
          action={rows.length === 0 ? { label: 'New intangible', onClick: () => setCreateOpen(true) } : undefined}
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="min-w-full divide-y divide-slate-800 text-sm">
            <thead className="bg-surface-900 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Asset</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 text-right font-medium">Cost</th>
                <th className="px-4 py-3 text-right font-medium">Accum. amort.</th>
                <th className="px-4 py-3 text-right font-medium">Net book value</th>
                <th className="px-4 py-3 text-right font-medium">Remaining life</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70 bg-surface-950">
              {filtered.map((r) => (
                <tr key={r.id} className="hover:bg-surface-900/50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-white">{r.name}</div>
                    <div className="text-xs text-slate-500">Acquired {r.acquisitionDate}</div>
                  </td>
                  <td className="px-4 py-3 text-slate-300">
                    <span className="inline-flex items-center gap-1">
                      {labelFor(r.category)}
                      {!r.amortizing && (
                        <span className="rounded bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-medium text-indigo-300">
                          no amort.
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-200">
                    {formatMoney(r.acquisitionCostCents)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-400">
                    {formatMoney(r.accumulatedAmortizationCents)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-white">
                    {formatMoney(r.netBookValueCents)}
                  </td>
                  <td className="px-4 py-3 text-right text-slate-300">{remainingLifeLabel(r)}</td>
                  <td className="px-4 py-3">
                    <span className={clsx('rounded px-2 py-0.5 text-xs font-medium', STATUS_CLS[r.status] ?? 'bg-slate-500/10 text-slate-400')}>
                      {STATUS_LABEL[r.status] ?? r.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {r.status !== 'DISPOSED' && r.netBookValueCents > 0 && (
                      <button
                        onClick={() => impair(r)}
                        className="rounded border border-slate-800 px-2 py-1 text-xs text-slate-300 hover:border-red-500/40 hover:text-red-300"
                      >
                        Impair
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {createOpen && (
        <CreateIntangiblePanel
          onClose={() => setCreateOpen(false)}
          onCreated={async () => {
            setCreateOpen(false);
            await refetch();
          }}
        />
      )}
    </div>
  );
}

// ── Create panel ──────────────────────────────────────────────────────────────

function CreateIntangiblePanel({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { data: locations } = useQuery<LocationOption[]>('/api/locations');
  const create = useMutation<Record<string, unknown>, { ok: boolean; assetId?: string }>('/api/intangibles');

  const [locationId, setLocationId] = useState('');
  // Default the company/location to the active company so a fresh company's
  // "New intangible" form is immediately usable.
  const { activeCompanyId } = useActiveCompany();
  useEffect(() => {
    if (!locationId && isSpecificCompany(activeCompanyId)) setLocationId(activeCompanyId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCompanyId]);
  const [name, setName] = useState('');
  const [category, setCategory] = useState<IntangibleCategory>('INTANGIBLE_SOFTWARE');
  const [cost, setCost] = useState('');
  const [salvage, setSalvage] = useState('');
  const [usefulLifeMonths, setUsefulLifeMonths] = useState('60');
  const [acquisitionDate, setAcquisitionDate] = useState(new Date().toISOString().slice(0, 10));
  const [rail, setRail] = useState('ach');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const goodwill = isNonAmortizing(category);
  const costNum = Number(cost);
  const canSubmit =
    locationId &&
    name.trim() &&
    Number.isFinite(costNum) &&
    costNum > 0 &&
    (goodwill || (Number.isInteger(Number(usefulLifeMonths)) && Number(usefulLifeMonths) > 0));

  async function submit() {
    if (!canSubmit) return;
    const payload: Record<string, unknown> = {
      locationId,
      name: name.trim(),
      category,
      costCents: dollarsToCents(costNum),
      salvageValueCents: salvage ? dollarsToCents(Number(salvage)) : 0,
      acquisitionDate,
      rail,
    };
    if (!goodwill) payload.usefulLifeMonths = Number(usefulLifeMonths);
    const res = await create.mutate(payload);
    if (res?.ok) {
      addToast('success', goodwill ? 'Goodwill recorded (held for impairment)' : 'Intangible created — amortization scheduled');
      onCreated();
    } else if (create.error) {
      addToast('error', create.error);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="New intangible asset"
        className="h-full w-full max-w-md overflow-y-auto border-l border-slate-800 bg-surface-950 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">New intangible asset</h2>
          <button onClick={onClose} aria-label="Close panel" className="text-slate-500 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4">
          <Field label="Company / location">
            <select
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              className="input"
            >
              <option value="">Select…</option>
              {(locations ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Core platform software" className="input" />
          </Field>

          <Field label="Type">
            <select value={category} onChange={(e) => setCategory(e.target.value as IntangibleCategory)} className="input">
              {INTANGIBLE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {INTANGIBLE_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Cost ($)">
              <input value={cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" placeholder="0.00" className="input font-mono" />
            </Field>
            <Field label="Residual ($)">
              <input value={salvage} onChange={(e) => setSalvage(e.target.value)} inputMode="decimal" placeholder="0.00" className="input font-mono" />
            </Field>
          </div>

          {goodwill ? (
            <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/5 px-3 py-2 text-xs text-indigo-200">
              Goodwill is not amortized under ASC 350. It is held at cost and tested for impairment; use the Impair action to record a write-down.
            </div>
          ) : (
            <Field label="Useful life (months)">
              <input
                value={usefulLifeMonths}
                onChange={(e) => setUsefulLifeMonths(e.target.value)}
                inputMode="numeric"
                placeholder="60"
                className="input font-mono"
              />
            </Field>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Acquisition date">
              <input type="date" value={acquisitionDate} onChange={(e) => setAcquisitionDate(e.target.value)} className="input" />
            </Field>
            <Field label="Paid via">
              <select value={rail} onChange={(e) => setRail(e.target.value)} className="input">
                <option value="ach">ACH</option>
                <option value="wire">Wire</option>
                <option value="check">Check</option>
                <option value="cash">Cash</option>
                <option value="debit_card">Debit card</option>
                <option value="credit_card">Credit card</option>
              </select>
            </Field>
          </div>

          {create.error && (
            <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-300">
              <AlertCircle className="h-4 w-4" /> {create.error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="rounded-lg border border-slate-800 px-4 py-2 text-sm text-slate-300 hover:text-white">
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={!canSubmit || create.isLoading}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-400 disabled:opacity-50"
            >
              {create.isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
              Create
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-400">{label}</span>
      {children}
    </label>
  );
}
