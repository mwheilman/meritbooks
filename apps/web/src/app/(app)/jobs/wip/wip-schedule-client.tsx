'use client';

import Link from 'next/link';
import { clsx } from 'clsx';
import { ArrowLeft, Loader2, AlertCircle, Inbox, Layers } from 'lucide-react';
import { PageHeader } from '@/components/ui';
import { formatMoney } from '@meritbooks/shared';
import { useQuery } from '@/hooks';

interface WipJob {
  jobId: string;
  jobNumber: string;
  jobName: string;
  status: string | null;
  company: string | null;
  contractValueCents: number;
  estimatedCostCents: number;
  costsToDateCents: number;
  pctCompleteDisplay: number;
  pctBasis: 'PHYSICAL' | 'COST_TO_COST';
  earnedRevenueCents: number;
  billedToDateCents: number;
  overBillingCents: number;
  underBillingCents: number;
  wipStatus: 'OVERBILLED' | 'UNDERBILLED' | 'ON_TARGET';
}

interface WipTotals {
  jobs: number;
  contractValueCents: number;
  estimatedCostCents: number;
  costsToDateCents: number;
  earnedRevenueCents: number;
  billedToDateCents: number;
  overBillingCents: number;
  underBillingCents: number;
  netWipCents: number;
  overbilledJobs: number;
  underbilledJobs: number;
}

interface WipSchedule {
  jobs: WipJob[];
  totals: WipTotals;
}

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

const STATUS_STYLE: Record<WipJob['wipStatus'], string> = {
  OVERBILLED: 'bg-amber-500/15 text-amber-300',
  UNDERBILLED: 'bg-blue-500/15 text-blue-300',
  ON_TARGET: 'bg-emerald-500/15 text-emerald-300',
};

export function WipScheduleClient() {
  const { data, isLoading, error } = useQuery<WipSchedule>('/api/jobs/wip');

  return (
    <div>
      <Link href="/jobs" className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-white mb-3"><ArrowLeft size={14} /> Jobs</Link>
      <PageHeader
        title="WIP Schedule"
        description="Work-in-progress over/under-billing across all open jobs — earned revenue vs billings"
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
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
            <SummaryTile label="Overbilled (Liability)" value={formatMoney(data.totals.overBillingCents)}
              sub={`${data.totals.overbilledJobs} job${data.totals.overbilledJobs === 1 ? '' : 's'} · billings in excess`} tone="warn" />
            <SummaryTile label="Underbilled (Asset)" value={formatMoney(data.totals.underBillingCents)}
              sub={`${data.totals.underbilledJobs} job${data.totals.underbilledJobs === 1 ? '' : 's'} · costs & earnings in excess`} tone="info" />
            <SummaryTile label="Net WIP Position" value={formatMoney(data.totals.netWipCents)}
              sub="underbilled − overbilled" tone={data.totals.netWipCents < 0 ? 'warn' : 'good'} />
            <SummaryTile label="Earned vs Billed"
              value={formatMoney(data.totals.earnedRevenueCents - data.totals.billedToDateCents)}
              sub={`${formatMoney(data.totals.earnedRevenueCents)} earned · ${formatMoney(data.totals.billedToDateCents)} billed`} />
          </div>

          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800 flex items-center gap-2">
              <Layers size={14} className="text-brand-400" />
              <h2 className="text-sm font-semibold text-white">Schedule · {data.totals.jobs} open job{data.totals.jobs === 1 ? '' : 's'}</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px]">
                <thead>
                  <tr className="border-b border-slate-800">
                    <th className="px-3 py-2 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Job</th>
                    <th className="px-3 py-2 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">% Compl.</th>
                    <th className="px-3 py-2 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Contract</th>
                    <th className="px-3 py-2 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Est. Cost</th>
                    <th className="px-3 py-2 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Costs to Date</th>
                    <th className="px-3 py-2 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Earned Rev.</th>
                    <th className="px-3 py-2 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Billed</th>
                    <th className="px-3 py-2 text-right text-2xs font-semibold uppercase tracking-wider text-amber-400">Overbilled</th>
                    <th className="px-3 py-2 text-right text-2xs font-semibold uppercase tracking-wider text-blue-400">Underbilled</th>
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
                      <td className="px-3 py-2.5 text-right text-sm font-mono text-slate-400">{formatMoney(j.estimatedCostCents)}</td>
                      <td className="px-3 py-2.5 text-right text-sm font-mono text-slate-400">{formatMoney(j.costsToDateCents)}</td>
                      <td className="px-3 py-2.5 text-right text-sm font-mono text-slate-200">{formatMoney(j.earnedRevenueCents)}</td>
                      <td className="px-3 py-2.5 text-right text-sm font-mono text-slate-200">{formatMoney(j.billedToDateCents)}</td>
                      <td className={clsx('px-3 py-2.5 text-right text-sm font-mono', j.overBillingCents > 0 ? 'text-amber-300' : 'text-slate-600')}>
                        {j.overBillingCents > 0 ? formatMoney(j.overBillingCents) : '--'}
                      </td>
                      <td className={clsx('px-3 py-2.5 text-right text-sm font-mono', j.underBillingCents > 0 ? 'text-blue-300' : 'text-slate-600')}>
                        {j.underBillingCents > 0 ? formatMoney(j.underBillingCents) : '--'}
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
                    <td className="px-3 py-2.5 text-right text-sm font-mono text-slate-300">{formatMoney(data.totals.estimatedCostCents)}</td>
                    <td className="px-3 py-2.5 text-right text-sm font-mono text-slate-300">{formatMoney(data.totals.costsToDateCents)}</td>
                    <td className="px-3 py-2.5 text-right text-sm font-mono text-white">{formatMoney(data.totals.earnedRevenueCents)}</td>
                    <td className="px-3 py-2.5 text-right text-sm font-mono text-white">{formatMoney(data.totals.billedToDateCents)}</td>
                    <td className="px-3 py-2.5 text-right text-sm font-mono text-amber-300">{formatMoney(data.totals.overBillingCents)}</td>
                    <td className="px-3 py-2.5 text-right text-sm font-mono text-blue-300">{formatMoney(data.totals.underBillingCents)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
