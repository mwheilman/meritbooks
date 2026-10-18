'use client';

import { useState, useCallback } from 'react';
import { Loader2, AlertCircle, Play, Eye, CheckCircle2, MinusCircle, AlertTriangle, Info } from 'lucide-react';
import { clsx } from 'clsx';
import { useRouter } from 'next/navigation';
import { useQuery, addToast } from '@/hooks';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { formatMoney } from '@meritbooks/shared';

type AccrualStatus = 'proposed' | 'accrued' | 'reversed' | 'already_accrued' | 'balanced' | 'skipped';

interface AccrualJob {
  jobId: string;
  jobNumber: string | null;
  jobName: string | null;
  earnedRevenueCents: number;
  billedToDateCents: number;
  underBillingCents: number;
  existingContractAssetCents: number;
  deltaCents: number;
  action: 'ACCRUE' | 'REVERSE' | 'NONE';
  status: AccrualStatus;
  entryNumber?: string;
  reason?: string;
}

interface AccrualResponse {
  ok: boolean;
  preview: boolean;
  asOf: string;
  period: string;
  unbilledAccount: { number: string; name: string } | null;
  underbilledJobs: number;
  jobsToPost: number;
  totalUnderBillingCents: number;
  existingContractAssetCents: number;
  proposedDeltaCents: number;
  projectedContractAssetCents: number;
  posted: number;
  reversed: number;
  skipped: number;
  jobs: AccrualJob[];
}

function defaultAsOf(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)).toISOString().slice(0, 10);
}

export function RevRecAccrual() {
  const [asOf, setAsOf] = useState(defaultAsOf());
  const [posting, setPosting] = useState(false);
  const { activeCompanyId, isAll } = useActiveCompany();

  // Preview via GET (no posting), auto company-scoped by the shared hook; re-fetch on asOf.
  const { data, isLoading, error, refetch } = useQuery<AccrualResponse>(
    '/api/rev-rec/accrue-unbilled',
    { as_of: asOf },
    { key: `accrual-${asOf}-${activeCompanyId}` },
  );
  const router = useRouter();

  const jobs = data?.jobs ?? [];
  const toPost = jobs.filter((j) => j.action !== 'NONE' && j.status === 'proposed');
  const tiesOut =
    !!data && data.projectedContractAssetCents === data.totalUnderBillingCents;

  const post = useCallback(async () => {
    if (isAll) {
      addToast('error', 'Select a single company before posting accruals.');
      return;
    }
    const count = toPost.length;
    if (
      !window.confirm(
        `Post ${count} unbilled-revenue accrual${count === 1 ? '' : 's'} as of ${asOf}?\n\n` +
          `This writes balanced journal entries: DR Unbilled Receivable (1180) / CR Revenue ` +
          `for the earned-but-unbilled amount on each underbilled job.`,
      )
    )
      return;
    setPosting(true);
    try {
      const res = await fetch('/api/rev-rec/accrue-unbilled', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ as_of: asOf, location_id: activeCompanyId }),
      });
      const result = await res.json();
      if (!res.ok) {
        addToast('error', result.error ?? 'Accrual failed');
        return;
      }
      const posted = (result.posted ?? 0) + (result.reversed ?? 0);
      addToast(
        'success',
        `Posted ${posted} accrual entr${posted === 1 ? 'y' : 'ies'} · ${formatMoney(result.proposedDeltaCents ?? 0)} to contract asset`,
      );
      refetch();
    } catch {
      addToast('error', 'Network error');
    } finally {
      setPosting(false);
    }
  }, [asOf, activeCompanyId, isAll, toPost.length, refetch]);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 flex items-start gap-2">
        <Info size={15} className="text-indigo-400 mt-0.5 shrink-0" />
        <p className="text-xs text-slate-400 leading-relaxed">
          When a job has <span className="text-emerald-400">earned more than it has billed</span> (WIP under-billing),
          accrue the earned revenue and the contract-asset receivable:{' '}
          <span className="font-mono text-slate-300">DR Unbilled Receivable (1180) / CR Revenue</span>. Only the delta
          needed to bring account 1180 up to the WIP under-billing is posted, so it is self-reversing as billing catches
          up and never double-counts. One accrual per job per period.
        </p>
      </div>

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <label className="text-2xs uppercase tracking-wider text-slate-500">Accrue as of</label>
          <input
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-md text-sm text-white font-mono"
          />
          <span className="inline-flex items-center gap-1 text-2xs text-slate-500">
            <Eye size={12} /> preview updates live
          </span>
        </div>
        <button
          onClick={post}
          disabled={posting || toPost.length === 0}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40"
        >
          {posting ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Post accruals ({toPost.length})
        </button>
      </div>

      {data && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Underbilled jobs" value={String(data.underbilledJobs)} />
          <Stat label="Net under-billing" value={formatMoney(data.totalUnderBillingCents)} tone="brand" />
          <Stat
            label="To post (delta)"
            value={formatMoney(data.proposedDeltaCents)}
            tone={data.proposedDeltaCents < 0 ? 'danger' : 'brand'}
          />
          <Stat label="Skipped" value={String(data.skipped)} tone={data.skipped > 0 ? 'warn' : undefined} />
        </div>
      )}

      {/* Tie-out: 1180 balance after accrual ties to WIP under-billing. */}
      {data && (
        <div
          className={clsx(
            'rounded-lg border p-3 flex items-center justify-between flex-wrap gap-2 text-xs',
            tiesOut ? 'border-emerald-800/60 bg-emerald-950/20' : 'border-amber-800/60 bg-amber-950/20',
          )}
        >
          <div className="flex items-center gap-2">
            {tiesOut ? (
              <CheckCircle2 size={15} className="text-emerald-400" />
            ) : (
              <AlertTriangle size={15} className="text-amber-400" />
            )}
            <span className="text-slate-300">
              Contract asset (acct {data.unbilledAccount?.number ?? '1180'}) after accrual{' '}
              <span className="font-mono text-white">{formatMoney(data.projectedContractAssetCents)}</span>{' '}
              {tiesOut ? 'ties to' : 'vs'} net WIP under-billing{' '}
              <span className="font-mono text-white">{formatMoney(data.totalUnderBillingCents)}</span>
            </span>
          </div>
          <span className="font-mono text-slate-500">
            on books now {formatMoney(data.existingContractAssetCents)}
          </span>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-5 h-5 text-emerald-400 animate-spin" />
        </div>
      ) : error ? (
        <div className="card p-6 text-center">
          <AlertCircle className="mx-auto text-red-400 mb-2" size={20} />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      ) : jobs.length === 0 ? (
        <div className="card p-10 text-center text-sm text-slate-500">
          No underbilled jobs — every job&apos;s billing is caught up to earned revenue. Nothing to accrue.
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Job</th>
                <th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Earned</th>
                <th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Billed</th>
                <th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Under-billing</th>
                <th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">On 1180</th>
                <th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">To post</th>
                <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/30">
              {jobs.map((j) => (
                <tr
                  key={j.jobId}
                  onClick={() => router.push(`/jobs/${j.jobId}`)}
                  className="row-clickable"
                >
                  <td className="px-4 py-2">
                    <span className="text-2xs font-mono text-slate-500">{j.jobNumber ?? '--'}</span>
                    <p className="text-sm text-slate-200 truncate max-w-[220px]">{j.jobName ?? j.jobId}</p>
                  </td>
                  <td className="px-4 py-2 text-right text-sm font-mono tabular-nums text-slate-300">{formatMoney(j.earnedRevenueCents)}</td>
                  <td className="px-4 py-2 text-right text-sm font-mono tabular-nums text-slate-400">{formatMoney(j.billedToDateCents)}</td>
                  <td className="px-4 py-2 text-right text-sm font-mono tabular-nums text-emerald-400">{formatMoney(j.underBillingCents)}</td>
                  <td className="px-4 py-2 text-right text-sm font-mono tabular-nums text-slate-500">{formatMoney(j.existingContractAssetCents)}</td>
                  <td
                    className={clsx(
                      'px-4 py-2 text-right text-sm font-mono tabular-nums',
                      j.deltaCents > 0 ? 'text-emerald-400' : j.deltaCents < 0 ? 'text-red-400' : 'text-slate-600',
                    )}
                  >
                    {j.deltaCents !== 0 ? formatMoney(j.deltaCents) : '—'}
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge job={j} preview={data?.preview ?? true} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ job, preview }: { job: AccrualJob; preview: boolean }) {
  if (job.status === 'proposed') {
    const isReverse = job.action === 'REVERSE';
    return (
      <span className={clsx('inline-flex items-center gap-1 text-2xs', isReverse ? 'text-red-300' : 'text-brand-300')}>
        <Eye size={11} /> {isReverse ? 'will reverse' : 'will accrue'}
      </span>
    );
  }
  if (job.status === 'accrued' || job.status === 'reversed') {
    return (
      <span className="inline-flex items-center gap-1 text-2xs text-emerald-400">
        <CheckCircle2 size={11} /> {job.status} {job.entryNumber ?? ''}
      </span>
    );
  }
  if (job.status === 'already_accrued') {
    return (
      <span className="inline-flex items-center gap-1 text-2xs text-slate-500" title={job.reason}>
        <CheckCircle2 size={11} /> already accrued
      </span>
    );
  }
  if (job.status === 'skipped') {
    return (
      <span className="inline-flex items-center gap-1 text-2xs text-amber-400" title={job.reason}>
        <AlertTriangle size={11} /> {job.reason ?? 'skipped'}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-2xs text-slate-600">
      <MinusCircle size={11} /> tied
    </span>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'brand' | 'warn' | 'danger' }) {
  return (
    <div className="card p-3">
      <p className="text-2xs uppercase tracking-wider text-slate-500 font-semibold">{label}</p>
      <p
        className={clsx(
          'text-lg font-mono font-semibold mt-1 tabular-nums',
          tone === 'brand' ? 'text-emerald-400' : tone === 'warn' ? 'text-amber-400' : tone === 'danger' ? 'text-red-400' : 'text-white',
        )}
      >
        {value}
      </p>
    </div>
  );
}
