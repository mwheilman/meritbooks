'use client';

import { useMemo, useState } from 'react';
import {
  Loader2,
  AlertCircle,
  Inbox,
  CheckCircle2,
  ShieldAlert,
  ShieldQuestion,
  Send,
  Users,
  FileWarning,
  DollarSign,
  FileOutput,
  type LucideIcon,
} from 'lucide-react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { useQuery, addToast } from '@/hooks';
import { api } from '@/lib/api-client';
import { PageHeader } from '@/components/ui';
import { Generate1099Modal } from './generate-1099-modal';

// ── Types (mirror /api/compliance/1099) ─────────────────────────────────────────

type W9State = 'on_file' | 'missing' | 'expired';
type Readiness = 'READY' | 'MISSING_W9' | 'NOT_MARKED_1099';

interface Ten99Row {
  vendorId: string;
  vendorName: string;
  totalPaidCents: number;
  paymentCount: number;
  is1099Eligible: boolean;
  w9Status: W9State;
  tinPresent: boolean;
  readiness: Readiness;
}

interface Ten99Summary {
  taxYear: number;
  thresholdCents: number;
  candidates: number;
  ready: number;
  missingDocs: number;
  dollarsAtRiskCents: number;
}

interface Ten99Report {
  summary: Ten99Summary;
  rows: Ten99Row[];
}

// ── Presentation maps ────────────────────────────────────────────────────────────

const READINESS_META: Record<Readiness, { label: string; className: string }> = {
  READY: { label: 'Ready', className: 'bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20' },
  MISSING_W9: { label: 'Missing W-9', className: 'bg-red-500/10 text-red-400 ring-1 ring-red-500/20' },
  NOT_MARKED_1099: { label: 'Not marked 1099', className: 'bg-amber-500/10 text-amber-400 ring-1 ring-amber-500/20' },
};

const W9_META: Record<W9State, { label: string; className: string }> = {
  on_file: { label: 'On file', className: 'text-emerald-400' },
  missing: { label: 'Missing', className: 'text-red-400' },
  expired: { label: 'Expired', className: 'text-amber-400' },
};

// ── Year options: current + prior 4 ──────────────────────────────────────────────

function yearOptions(): number[] {
  const y = new Date().getFullYear();
  return [y, y - 1, y - 2, y - 3, y - 4];
}

// ── Summary tile ─────────────────────────────────────────────────────────────────

function Tile({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div className="card flex items-center gap-3 p-4">
      <div className={clsx('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', accent)}>
        <Icon size={18} />
      </div>
      <div className="min-w-0">
        <p className="truncate text-xs text-slate-500">{label}</p>
        <p className="font-mono text-lg font-semibold text-white">{value}</p>
      </div>
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────────

export function Compliance1099Client() {
  const years = useMemo(yearOptions, []);
  const [year, setYear] = useState<number>(years[0]);
  const { data, isLoading, error, refetch } = useQuery<Ten99Report>('/api/compliance/1099', {
    year: String(year),
  });
  const [flaggingId, setFlaggingId] = useState<string | null>(null);
  const [queued, setQueued] = useState<Set<string>>(new Set());
  const [showGenerate, setShowGenerate] = useState(false);

  const rows = data?.rows ?? [];
  const summary = data?.summary;

  async function flag(row: Ten99Row) {
    setFlaggingId(row.vendorId);
    const res = await api.post<{ queued: boolean; alreadyQueued: boolean }>('/api/compliance/1099', {
      vendorId: row.vendorId,
      year,
    });
    setFlaggingId(null);
    if (res.error) {
      addToast('error', res.error.error || 'Could not queue W-9 chase');
      return;
    }
    setQueued((prev) => new Set(prev).add(row.vendorId));
    addToast(
      'success',
      res.data?.alreadyQueued
        ? `${row.vendorName} — W-9 chase already queued`
        : `Queued W-9 chase for ${row.vendorName}`,
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="1099-NEC Readiness"
        description={`Vendors paid $600 or more by check / ACH / wire in ${year} — card payments excluded (those are 1099-K). Flag gaps to queue a W-9 chase, then generate the 1099s.`}
      />

      {/* Tax-year selector + generate */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <label htmlFor="tax-year" className="text-xs text-slate-500">
            Tax year
          </label>
          <select
            id="tax-year"
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-1.5 text-sm text-white focus:border-emerald-500/50 focus:outline-none"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={() => setShowGenerate(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3.5 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-400"
        >
          <FileOutput size={15} /> Generate 1099s
        </button>
      </div>

      {showGenerate && <Generate1099Modal year={year} onClose={() => setShowGenerate(false)} />}

      {/* Summary tiles */}
      {!isLoading && !error && summary && summary.candidates > 0 && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Tile icon={Users} label="Candidates (>= $600)" value={String(summary.candidates)} accent="bg-slate-500/10 text-slate-300" />
          <Tile icon={CheckCircle2} label="Ready to file" value={String(summary.ready)} accent="bg-emerald-500/10 text-emerald-400" />
          <Tile icon={FileWarning} label="Missing docs" value={String(summary.missingDocs)} accent="bg-red-500/10 text-red-400" />
          <Tile icon={DollarSign} label="$ at risk" value={formatMoney(summary.dollarsAtRiskCents)} accent="bg-amber-500/10 text-amber-400" />
        </div>
      )}

      {/* Content states */}
      {isLoading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-6 w-6 animate-spin text-emerald-400" />
        </div>
      ) : error ? (
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
      ) : rows.length === 0 ? (
        <div className="card p-16 text-center">
          <Inbox className="mx-auto mb-3 h-10 w-10 text-slate-600" />
          <p className="text-sm font-medium text-white">No 1099 candidates for {year}</p>
          <p className="mt-1 text-xs text-slate-500">
            No vendor was paid $600 or more by a reportable rail in this tax year.
          </p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-left text-xs text-slate-500">
                  <th className="px-4 py-3 font-medium">Vendor</th>
                  <th className="px-4 py-3 text-right font-medium">Total paid ({year})</th>
                  <th className="px-4 py-3 text-center font-medium">1099-eligible</th>
                  <th className="px-4 py-3 font-medium">W-9</th>
                  <th className="px-4 py-3 text-center font-medium">TIN</th>
                  <th className="px-4 py-3 font-medium">Readiness</th>
                  <th className="px-4 py-3 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/40">
                {rows.map((row) => {
                  const rm = READINESS_META[row.readiness];
                  const wm = W9_META[row.w9Status];
                  const isGap = row.readiness !== 'READY';
                  const isQueued = queued.has(row.vendorId);
                  return (
                    <tr key={row.vendorId} className="transition-colors hover:bg-slate-800/30">
                      <td className="px-4 py-3">
                        <span className="font-medium text-white">{row.vendorName}</span>
                        <span className="ml-2 text-xs text-slate-500">
                          {row.paymentCount} pmt{row.paymentCount === 1 ? '' : 's'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-slate-200">
                        {formatMoney(row.totalPaidCents)}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {row.is1099Eligible ? (
                          <span className="text-emerald-400">Yes</span>
                        ) : (
                          <span className="text-slate-500">No</span>
                        )}
                      </td>
                      <td className={clsx('px-4 py-3 font-medium', wm.className)}>{wm.label}</td>
                      <td className="px-4 py-3 text-center">
                        {row.tinPresent ? (
                          <span className="text-emerald-400">Yes</span>
                        ) : (
                          <span className="text-red-400">No</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={clsx('inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium', rm.className)}>
                          {row.readiness === 'READY' ? (
                            <CheckCircle2 size={12} />
                          ) : row.readiness === 'MISSING_W9' ? (
                            <ShieldAlert size={12} />
                          ) : (
                            <ShieldQuestion size={12} />
                          )}
                          {rm.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {isGap ? (
                          <button
                            type="button"
                            disabled={flaggingId === row.vendorId || isQueued}
                            onClick={() => flag(row)}
                            className={clsx(
                              'inline-flex items-center justify-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors',
                              isQueued
                                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                                : 'border-slate-700 bg-slate-800/40 text-slate-300 hover:border-emerald-500/40 hover:bg-emerald-500/10 hover:text-emerald-400',
                              'disabled:cursor-not-allowed disabled:opacity-60',
                            )}
                          >
                            {flaggingId === row.vendorId ? (
                              <Loader2 size={13} className="animate-spin" />
                            ) : isQueued ? (
                              <>
                                <CheckCircle2 size={13} /> Queued
                              </>
                            ) : (
                              <>
                                <Send size={13} /> Flag W-9
                              </>
                            )}
                          </button>
                        ) : (
                          <span className="text-xs text-slate-600">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
