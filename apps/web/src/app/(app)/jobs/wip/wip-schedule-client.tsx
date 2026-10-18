'use client';

import { useState } from 'react';
import Link from 'next/link';
import { clsx } from 'clsx';
import {
  ArrowLeft, Loader2, AlertCircle, Inbox, Layers, TrendingDown, AlertTriangle, CircleAlert,
} from 'lucide-react';
import { PageHeader } from '@/components/ui';
import { formatMoney } from '@meritbooks/shared';
import { useQuery } from '@/hooks';

/** Mirror of JobPLResult / JobPLPortfolioTotals (lib/jobs/job-pl.ts). */
interface PLJob {
  jobId: string;
  jobNumber: string;
  jobName: string;
  status: string | null;
  company: string | null;
  contractValueCents: number;
  estimatedCostCents: number;
  costsToDateCents: number;
  eacCents: number;
  billedToDateCents: number;
  earnedRevenueCents: number;
  overBillingCents: number;
  underBillingCents: number;
  pctCompleteDisplay: number;
  costPctCompleteDisplay: number;
  pctBasis: 'PHYSICAL' | 'COST_TO_COST';
  projectedFinalMarginCents: number;
  projectedFinalMarginPct: number | null;
  wipStatus: 'OVERBILLED' | 'UNDERBILLED' | 'ON_TARGET';
  projectedLoss: boolean;
  marginFade: boolean;
  overBudget: boolean;
  glCostTied: boolean;
}

interface PLTotals {
  jobs: number;
  contractValueCents: number;
  estimatedCostCents: number;
  costsToDateCents: number;
  eacCents: number;
  earnedRevenueCents: number;
  billedToDateCents: number;
  overBillingCents: number;
  underBillingCents: number;
  netWipCents: number;
  projectedFinalMarginCents: number;
  projectedFinalMarginPct: number | null;
  overbilledJobs: number;
  underbilledJobs: number;
  projectedLossJobs: number;
  marginFadeJobs: number;
  overBudgetJobs: number;
  projectedLossExposureCents: number;
  glUntiedJobs: number;
}

interface Portfolio {
  method: string;
  jobs: PLJob[];
  totals: PLTotals;
}

const METHODS: { value: 'COMMITMENTS' | 'COST_TO_COST' | 'PROGRESS'; label: string; hint: string }[] = [
  { value: 'COMMITMENTS', label: 'Commitments', hint: 'costs to date + open commitments (default)' },
  { value: 'COST_TO_COST', label: 'Cost-to-cost', hint: 'holds the budget unless actuals exceed it' },
  { value: 'PROGRESS', label: 'Physical %', hint: 'CPI projection from measured %-complete' },
];

function SummaryTile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' | 'bad' | 'warn' | 'info' }) {
  return (
    <div className="card p-4">
      <p className="text-2xs uppercase tracking-wider text-slate-500 font-semibold">{label}</p>
      <p className={clsx('text-xl font-mono font-semibold mt-1',
        tone === 'good' ? 'text-emerald-400' : tone === 'bad' ? 'text-red-400' : tone === 'warn' ? 'text-amber-400' : tone === 'info' ? 'text-blue-400' : 'text-white')}>
        {value}
      </p>
      {sub && <p className="text-2xs text-slate-500 mt-0.5">{sub}</p>}
    </div>
  );
}

const STATUS_STYLE: Record<PLJob['wipStatus'], string> = {
  OVERBILLED: 'bg-amber-500/15 text-amber-300',
  UNDERBILLED: 'bg-blue-500/15 text-blue-300',
  ON_TARGET: 'bg-emerald-500/15 text-emerald-300',
};

function marginColor(pct: number | null): string {
  if (pct == null) return 'text-slate-500';
  if (pct < 0) return 'text-red-400';
  if (pct < 10) return 'text-amber-400';
  return 'text-emerald-400';
}

export function WipScheduleClient() {
  const [method, setMethod] = useState<'COMMITMENTS' | 'COST_TO_COST' | 'PROGRESS'>('COMMITMENTS');
  const { data, isLoading, error } = useQuery<Portfolio>('/api/jobs/pl', { method });

  return (
    <div>
      <Link href="/jobs" className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-white mb-3"><ArrowLeft size={14} /> Jobs</Link>
      <PageHeader
        title="WIP Schedule"
        description="Work-in-progress across all open jobs — earned revenue vs billings, EAC, and margin at completion"
        actions={
          <div className="flex items-center gap-1 rounded-lg bg-slate-800/50 p-0.5">
            {METHODS.map((m) => (
              <button key={m.value} onClick={() => setMethod(m.value)} title={m.hint}
                className={clsx('px-2.5 py-1 rounded-md text-2xs font-medium transition-colors',
                  method === m.value ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200')}>
                {m.label}
              </button>
            ))}
          </div>
        }
      />

      {isLoading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 text-emerald-400 animate-spin" /></div>
      ) : error ? (
        <div className="card p-8 text-center"><AlertCircle size={24} className="mx-auto text-red-400 mb-2" /><p className="text-sm text-red-400">{error}</p></div>
      ) : !data || data.jobs.length === 0 ? (
        <div className="card p-12 text-center">
          <Inbox size={28} className="mx-auto mb-2 text-slate-600" />
          <p className="text-sm text-slate-400">No open jobs to schedule.</p>
          <p className="text-2xs text-slate-500 mt-1">Jobs appear here once they are ACTIVE, ON_HOLD, or COMPLETE.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <SummaryTile label="Overbilled (Liability)" value={formatMoney(data.totals.overBillingCents)}
              sub={`${data.totals.overbilledJobs} job${data.totals.overbilledJobs === 1 ? '' : 's'} · billings in excess`} tone="warn" />
            <SummaryTile label="Underbilled (Asset)" value={formatMoney(data.totals.underBillingCents)}
              sub={`${data.totals.underbilledJobs} job${data.totals.underbilledJobs === 1 ? '' : 's'} · costs & earnings in excess`} tone="info" />
            <SummaryTile label="Net WIP Position" value={formatMoney(data.totals.netWipCents)}
              sub="underbilled − overbilled" tone={data.totals.netWipCents < 0 ? 'warn' : 'good'} />
            <SummaryTile label="Projected Margin at Completion"
              value={data.totals.projectedFinalMarginPct != null ? `${data.totals.projectedFinalMarginPct}%` : '--'}
              sub={`${formatMoney(data.totals.projectedFinalMarginCents)} on ${formatMoney(data.totals.contractValueCents)} backlog`}
              tone={data.totals.projectedFinalMarginCents < 0 ? 'bad' : 'good'} />
          </div>

          {/* Risk banner */}
          {(data.totals.projectedLossJobs > 0 || data.totals.marginFadeJobs > 0 || data.totals.overBudgetJobs > 0 || data.totals.glUntiedJobs > 0) && (
            <div className="flex flex-wrap gap-2 mb-4">
              {data.totals.projectedLossJobs > 0 && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-2xs font-semibold bg-red-500/15 text-red-300">
                  <TrendingDown size={12} /> {data.totals.projectedLossJobs} projecting a loss · {formatMoney(data.totals.projectedLossExposureCents)} exposure
                </span>
              )}
              {data.totals.marginFadeJobs > 0 && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-2xs font-semibold bg-amber-500/15 text-amber-300">
                  <AlertTriangle size={12} /> {data.totals.marginFadeJobs} fading vs original margin
                </span>
              )}
              {data.totals.overBudgetJobs > 0 && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-2xs font-semibold bg-amber-500/15 text-amber-300">
                  <AlertTriangle size={12} /> {data.totals.overBudgetJobs} over budget (EAC &gt; budget)
                </span>
              )}
              {data.totals.glUntiedJobs > 0 && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-2xs font-semibold bg-slate-700/40 text-slate-300">
                  <CircleAlert size={12} /> {data.totals.glUntiedJobs} not tied to the GL
                </span>
              )}
            </div>
          )}

          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800 flex items-center gap-2">
              <Layers size={14} className="text-brand-400" />
              <h2 className="text-sm font-semibold text-white">Schedule · {data.totals.jobs} open job{data.totals.jobs === 1 ? '' : 's'}</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1040px]">
                <thead>
                  <tr className="border-b border-slate-800">
                    <th className="px-3 py-2 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Job</th>
                    <th className="px-3 py-2 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">% Compl.</th>
                    <th className="px-3 py-2 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Contract</th>
                    <th className="px-3 py-2 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Cost to Date</th>
                    <th className="px-3 py-2 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">EAC</th>
                    <th className="px-3 py-2 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Billed</th>
                    <th className="px-3 py-2 text-right text-2xs font-semibold uppercase tracking-wider text-amber-400">Overbilled</th>
                    <th className="px-3 py-2 text-right text-2xs font-semibold uppercase tracking-wider text-blue-400">Underbilled</th>
                    <th className="px-3 py-2 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Proj. Margin</th>
                    <th className="px-3 py-2 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/30">
                  {data.jobs.map((j) => (
                    <tr key={j.jobId} className="table-row-hover">
                      <td className="px-3 py-2.5">
                        <Link href={`/jobs/${j.jobId}`} className="group inline-flex flex-col">
                          <span className="text-sm text-slate-200 group-hover:text-white truncate max-w-[220px]">{j.jobName}</span>
                          <span className="text-2xs font-mono text-slate-500">{j.jobNumber}{j.company ? ` · ${j.company}` : ''}</span>
                        </Link>
                      </td>
                      <td className="px-3 py-2.5 text-right text-sm font-mono text-slate-300">
                        {j.pctCompleteDisplay}%
                        <span className="block text-2xs text-slate-600">{j.pctBasis === 'PHYSICAL' ? 'physical' : 'cost-to-cost'}</span>
                      </td>
                      <td className="px-3 py-2.5 text-right text-sm font-mono text-slate-300">{formatMoney(j.contractValueCents)}</td>
                      <td className="px-3 py-2.5 text-right text-sm font-mono text-slate-400">{formatMoney(j.costsToDateCents)}</td>
                      <td className={clsx('px-3 py-2.5 text-right text-sm font-mono', j.overBudget ? 'text-amber-300' : 'text-slate-300')}>
                        {formatMoney(j.eacCents)}
                      </td>
                      <td className="px-3 py-2.5 text-right text-sm font-mono text-slate-200">{formatMoney(j.billedToDateCents)}</td>
                      <td className={clsx('px-3 py-2.5 text-right text-sm font-mono', j.overBillingCents > 0 ? 'text-amber-300' : 'text-slate-600')}>
                        {j.overBillingCents > 0 ? formatMoney(j.overBillingCents) : '--'}
                      </td>
                      <td className={clsx('px-3 py-2.5 text-right text-sm font-mono', j.underBillingCents > 0 ? 'text-blue-300' : 'text-slate-600')}>
                        {j.underBillingCents > 0 ? formatMoney(j.underBillingCents) : '--'}
                      </td>
                      <td className={clsx('px-3 py-2.5 text-right text-sm font-mono', marginColor(j.projectedFinalMarginPct))}>
                        {j.projectedFinalMarginPct != null ? `${j.projectedFinalMarginPct}%` : '--'}
                        {(j.projectedLoss || j.marginFade) && (
                          <span className="block text-2xs">
                            {j.projectedLoss
                              ? <span className="text-red-400 inline-flex items-center gap-0.5"><TrendingDown size={9} /> loss</span>
                              : <span className="text-amber-400 inline-flex items-center gap-0.5"><AlertTriangle size={9} /> fade</span>}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={clsx('inline-block px-2 py-0.5 rounded text-2xs font-semibold', STATUS_STYLE[j.wipStatus])}>
                          {j.wipStatus === 'ON_TARGET' ? 'On target' : j.wipStatus === 'OVERBILLED' ? 'Overbilled' : 'Underbilled'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-slate-700 bg-slate-800/20">
                    <td className="px-3 py-2.5 text-2xs font-semibold uppercase tracking-wider text-slate-400">Total</td>
                    <td />
                    <td className="px-3 py-2.5 text-right text-sm font-mono text-slate-200">{formatMoney(data.totals.contractValueCents)}</td>
                    <td className="px-3 py-2.5 text-right text-sm font-mono text-slate-300">{formatMoney(data.totals.costsToDateCents)}</td>
                    <td className="px-3 py-2.5 text-right text-sm font-mono text-slate-300">{formatMoney(data.totals.eacCents)}</td>
                    <td className="px-3 py-2.5 text-right text-sm font-mono text-white">{formatMoney(data.totals.billedToDateCents)}</td>
                    <td className="px-3 py-2.5 text-right text-sm font-mono text-amber-300">{formatMoney(data.totals.overBillingCents)}</td>
                    <td className="px-3 py-2.5 text-right text-sm font-mono text-blue-300">{formatMoney(data.totals.underBillingCents)}</td>
                    <td className={clsx('px-3 py-2.5 text-right text-sm font-mono font-semibold', marginColor(data.totals.projectedFinalMarginPct))}>
                      {data.totals.projectedFinalMarginPct != null ? `${data.totals.projectedFinalMarginPct}%` : '--'}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          <p className="text-2xs text-slate-600 mt-3">
            Earned revenue = contract × %-complete. EAC and margin fade are projected by the selected method; every figure is
            computed deterministically in code (lib/jobs/job-pl.ts) and ties to the GL.
          </p>
        </>
      )}
    </div>
  );
}
