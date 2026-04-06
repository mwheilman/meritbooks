'use client';

import { useQuery } from '@/hooks';
import { formatMoney, pct } from '@meritbooks/shared';
import { Loader2, AlertCircle } from 'lucide-react';
import { clsx } from 'clsx';

interface JobProfRow {
  jobNumber: string;
  jobName: string;
  customerName: string;
  locationName: string;
  status: string;
  contractAmountCents: number;
  actualCostCents: number;
  billedCents: number;
  profitCents: number;
  marginPct: number;
  pctComplete: number;
  overUnderBilledCents: number;
}

interface JobProfData {
  data: JobProfRow[];
  summary: {
    totalContractCents: number;
    totalCostCents: number;
    totalBilledCents: number;
    totalProfitCents: number;
    avgMarginPct: number;
    jobCount: number;
  };
}

function marginColor(m: number): string {
  if (m >= 20) return 'text-emerald-400';
  if (m >= 10) return 'text-amber-400';
  if (m >= 0) return 'text-orange-400';
  return 'text-red-400';
}

function marginBarColor(m: number): string {
  if (m >= 20) return 'bg-emerald-500';
  if (m >= 10) return 'bg-amber-500';
  if (m >= 0) return 'bg-orange-500';
  return 'bg-red-500';
}

export function JobProfitabilityReport({ params }: { params: Record<string, string> }) {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v));
  const qs = new URLSearchParams(clean).toString();
  const { data, isLoading, error } = useQuery<JobProfData>(`/api/reports/job-profitability${qs ? '?' + qs : ''}`);

  if (isLoading) return <div className="card p-12 flex items-center justify-center"><Loader2 size={24} className="animate-spin text-slate-500" /></div>;
  if (error) return <div className="card p-8 text-center"><AlertCircle size={24} className="mx-auto text-red-400 mb-2" /><p className="text-sm text-red-400">{String(error)}</p></div>;
  if (!data || data.data.length === 0) return <div className="card p-8 text-center text-sm text-slate-500">No jobs with cost data.</div>;

  const { data: jobs, summary: s } = data;

  return (
    <div className="space-y-4">
      {/* Summary metrics */}
      <div className="grid grid-cols-5 gap-3">
        <div className="card p-4">
          <p className="text-[10px] text-slate-500 uppercase mb-1">Jobs</p>
          <p className="text-xl font-mono font-semibold text-white">{s.jobCount}</p>
        </div>
        <div className="card p-4">
          <p className="text-[10px] text-slate-500 uppercase mb-1">Contract Value</p>
          <p className="text-xl font-mono font-semibold text-white">{formatMoney(s.totalContractCents, { compact: true })}</p>
        </div>
        <div className="card p-4">
          <p className="text-[10px] text-slate-500 uppercase mb-1">Total Cost</p>
          <p className="text-xl font-mono font-semibold text-amber-400">{formatMoney(s.totalCostCents, { compact: true })}</p>
        </div>
        <div className="card p-4">
          <p className="text-[10px] text-slate-500 uppercase mb-1">Gross Profit</p>
          <p className={clsx('text-xl font-mono font-semibold', s.totalProfitCents >= 0 ? 'text-emerald-400' : 'text-red-400')}>
            {formatMoney(s.totalProfitCents, { compact: true })}
          </p>
        </div>
        <div className="card p-4">
          <p className="text-[10px] text-slate-500 uppercase mb-1">Avg Margin</p>
          <p className={clsx('text-xl font-mono font-semibold', marginColor(s.avgMarginPct))}>{s.avgMarginPct}%</p>
        </div>
      </div>

      {/* Job table */}
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800">
              <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Job</th>
              <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Customer</th>
              <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500 w-16">Co</th>
              <th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500">Contract</th>
              <th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500">Cost</th>
              <th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500">Billed</th>
              <th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500">Over/Under</th>
              <th className="px-4 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500 w-20">% Done</th>
              <th className="px-4 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500 w-32">Margin</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/30">
            {jobs.map((job) => {
              const overUnder = job.overUnderBilledCents;
              return (
                <tr key={job.jobNumber} className="hover:bg-slate-800/20">
                  <td className="px-4 py-3">
                    <p className="text-sm text-white font-medium">{job.jobName}</p>
                    <p className="text-[10px] text-slate-600 font-mono">{job.jobNumber}</p>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400">{job.customerName || '—'}</td>
                  <td className="px-4 py-3 text-xs font-mono text-slate-500">{job.locationName}</td>
                  <td className="px-4 py-3 text-right text-xs font-mono text-slate-300">{formatMoney(job.contractAmountCents)}</td>
                  <td className="px-4 py-3 text-right text-xs font-mono text-slate-400">{formatMoney(job.actualCostCents)}</td>
                  <td className="px-4 py-3 text-right text-xs font-mono text-slate-300">{formatMoney(job.billedCents)}</td>
                  <td className={clsx('px-4 py-3 text-right text-xs font-mono', overUnder > 0 ? 'text-amber-400' : overUnder < 0 ? 'text-blue-400' : 'text-slate-500')}>
                    {overUnder > 0 ? '+' : ''}{formatMoney(overUnder)}
                    <span className="text-[10px] text-slate-600 ml-1">{overUnder > 0 ? 'over' : overUnder < 0 ? 'under' : ''}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 rounded-full bg-slate-700 overflow-hidden">
                        <div className="h-full rounded-full bg-blue-500" style={{ width: `${Math.min(job.pctComplete, 100)}%` }} />
                      </div>
                      <span className="text-[10px] font-mono text-slate-400 w-8 text-right">{job.pctComplete}%</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-2 rounded-full bg-slate-700 overflow-hidden">
                        <div className={clsx('h-full rounded-full', marginBarColor(job.marginPct))} style={{ width: `${Math.min(Math.max(job.marginPct, 0), 100)}%` }} />
                      </div>
                      <span className={clsx('text-xs font-mono font-medium w-10 text-right', marginColor(job.marginPct))}>
                        {job.marginPct}%
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-700 bg-slate-800/30">
              <td colSpan={3} className="px-4 py-2.5 text-sm font-semibold text-white">Totals</td>
              <td className="px-4 py-2.5 text-right text-xs font-mono font-semibold text-white">{formatMoney(s.totalContractCents)}</td>
              <td className="px-4 py-2.5 text-right text-xs font-mono font-semibold text-slate-400">{formatMoney(s.totalCostCents)}</td>
              <td className="px-4 py-2.5 text-right text-xs font-mono font-semibold text-white">{formatMoney(s.totalBilledCents)}</td>
              <td colSpan={2} />
              <td className={clsx('px-4 py-2.5 text-center text-sm font-mono font-bold', marginColor(s.avgMarginPct))}>{s.avgMarginPct}%</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
