'use client';

import { useState } from 'react';
import { clsx } from 'clsx';
import { StatusBadge } from '@/components/ui';
import { formatMoney } from '@meritbooks/shared';

interface JobRow {
  id: string;
  jobNumber: string;
  name: string;
  customer: string;
  locationName: string;
  locationCode: string;
  jobType: string;
  status: string;
  contractCents: number;
  estimatedCostCents: number;
  actualCostCents: number;
  billedCents: number;
  pctComplete: number;
  profitMargin: number;
  startDate: string;
  estCompletion: string;
}

const TABS = ['All', 'Active', 'Bid', 'Complete'] as const;

const DEMO_JOBS: JobRow[] = [
  { id: '1', jobNumber: 'SCC-2026-042', name: 'Smith Kitchen Remodel', customer: 'John Smith', locationName: 'Swan Creek Construction', locationCode: 'SCC', jobType: 'CONSTRUCTION', status: 'ACTIVE', contractCents: 12500000, estimatedCostCents: 8750000, actualCostCents: 5200000, billedCents: 6250000, pctComplete: 58, profitMargin: 30.0, startDate: '2026-02-15', estCompletion: '2026-05-30' },
  { id: '2', jobNumber: 'ICC-2026-018', name: 'Williams Master Bath', customer: 'Sarah Williams', locationName: 'Iowa Custom Cabinetry', locationCode: 'ICC', jobType: 'CABINETRY', status: 'ACTIVE', contractCents: 4800000, estimatedCostCents: 3200000, actualCostCents: 2800000, billedCents: 3360000, pctComplete: 72, profitMargin: 33.3, startDate: '2026-01-20', estCompletion: '2026-04-15' },
  { id: '3', jobNumber: 'HH-2026-089', name: 'Johnson HVAC Replacement', customer: 'Mike Johnson', locationName: 'Heartland HVAC', locationCode: 'HH', jobType: 'HVAC', status: 'ACTIVE', contractCents: 1850000, estimatedCostCents: 1200000, actualCostCents: 980000, billedCents: 925000, pctComplete: 45, profitMargin: 35.1, startDate: '2026-03-10', estCompletion: '2026-04-20' },
  { id: '4', jobNumber: 'SCC-2026-047', name: 'Davis Basement Finish', customer: 'Robert Davis', locationName: 'Swan Creek Construction', locationCode: 'SCC', jobType: 'CONSTRUCTION', status: 'BID', contractCents: 8500000, estimatedCostCents: 5950000, actualCostCents: 0, billedCents: 0, pctComplete: 0, profitMargin: 30.0, startDate: '', estCompletion: '' },
  { id: '5', jobNumber: 'CIR-2026-012', name: 'Henderson Water Damage', customer: 'Tom Henderson', locationName: 'Central Iowa Restoration', locationCode: 'CIR', jobType: 'SERVICE', status: 'ACTIVE', contractCents: 3200000, estimatedCostCents: 2100000, actualCostCents: 2400000, billedCents: 2560000, pctComplete: 88, profitMargin: 25.0, startDate: '2026-02-01', estCompletion: '2026-04-10' },
  { id: '6', jobNumber: 'DM-2026-034', name: 'Parker Office Build-Out', customer: 'Parker LLC', locationName: 'Dorrian Mechanical', locationCode: 'DM', jobType: 'HVAC', status: 'COMPLETE', contractCents: 2400000, estimatedCostCents: 1680000, actualCostCents: 1720000, billedCents: 2400000, pctComplete: 100, profitMargin: 28.3, startDate: '2025-11-15', estCompletion: '2026-03-01' },
  { id: '7', jobNumber: 'AIN-2026-008', name: 'Morrison Living Room', customer: 'Lisa Morrison', locationName: 'Artistry Interiors', locationCode: 'AIN', jobType: 'CONSTRUCTION', status: 'ACTIVE', contractCents: 6800000, estimatedCostCents: 4760000, actualCostCents: 1200000, billedCents: 1360000, pctComplete: 18, profitMargin: 30.0, startDate: '2026-03-20', estCompletion: '2026-07-15' },
];

function ProgressBar({ pct, overBudget }: { pct: number; overBudget: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-20 rounded-full bg-slate-800 overflow-hidden">
        <div
          className={clsx(
            'h-full rounded-full transition-all',
            overBudget ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-brand-500',
          )}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <span className={clsx(
        'text-2xs font-mono tabular-nums',
        overBudget ? 'text-red-400' : 'text-slate-400',
      )}>
        {pct}%
      </span>
    </div>
  );
}

export function JobList() {
  const [activeTab, setActiveTab] = useState<string>('All');

  const filtered = activeTab === 'All'
    ? DEMO_JOBS
    : DEMO_JOBS.filter((j) => j.status === activeTab.toUpperCase());

  return (
    <div>
      {/* Tabs */}
      <div className="flex items-center gap-1 mb-4">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={clsx(
              'px-3 py-1.5 rounded-md text-sm transition-colors',
              activeTab === tab ? 'bg-slate-800 text-white font-medium' : 'text-slate-400 hover:text-slate-300',
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-800">
              <th className="px-5 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Job</th>
              <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Customer</th>
              <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Company</th>
              <th className="px-4 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Contract</th>
              <th className="px-4 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Actual Cost</th>
              <th className="px-4 py-3 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500">Budget Used</th>
              <th className="px-4 py-3 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500">% Complete</th>
              <th className="px-4 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Margin</th>
              <th className="px-4 py-3 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/30">
            {filtered.map((job) => {
              const budgetUsedPct = job.estimatedCostCents > 0
                ? Math.round((job.actualCostCents / job.estimatedCostCents) * 100) : 0;
              const overBudget = job.actualCostCents > job.estimatedCostCents;

              return (
                <tr key={job.id} className="table-row-hover cursor-pointer">
                  <td className="px-5 py-3">
                    <p className="text-sm font-medium text-slate-200">{job.name}</p>
                    <p className="text-2xs text-brand-400 font-mono mt-0.5">{job.jobNumber}</p>
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-400">{job.customer}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="h-5 w-5 rounded bg-slate-800 flex items-center justify-center text-2xs font-bold text-slate-500">
                        {job.locationCode.slice(0, 2)}
                      </div>
                      <span className="text-sm text-slate-300">{job.locationCode}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-mono tabular-nums text-slate-200">
                    {formatMoney(job.contractCents, { compact: true })}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className={clsx(
                      'text-sm font-mono tabular-nums',
                      overBudget ? 'text-red-400' : 'text-slate-300',
                    )}>
                      {formatMoney(job.actualCostCents, { compact: true })}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <ProgressBar pct={budgetUsedPct} overBudget={overBudget} />
                  </td>
                  <td className="px-4 py-3 text-center">
                    <ProgressBar pct={job.pctComplete} overBudget={false} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className={clsx(
                      'text-sm font-mono tabular-nums font-medium',
                      job.profitMargin >= 30 ? 'text-emerald-400' : job.profitMargin >= 20 ? 'text-amber-400' : 'text-red-400',
                    )}>
                      {job.profitMargin.toFixed(1)}%
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <StatusBadge status={job.status} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
