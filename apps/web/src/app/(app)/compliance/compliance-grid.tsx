'use client';

import { clsx } from 'clsx';
import { Check, Clock, AlertTriangle, FileText } from 'lucide-react';
import { MetricCard } from '@/components/ui';
import { Shield, CheckCircle } from 'lucide-react';

const OBLIGATIONS = ['Sales Tax', 'Fed 941', 'State WH', 'Monthly Fin', 'State UI', 'Property Tax'] as const;

const COMPANIES = ['MMG', 'SCC', 'ICC', 'HH', 'DM', 'CIR', 'AIN', 'WI'];

type Status = 'FILED' | 'AUTO_VERIFIED' | 'IN_PROGRESS' | 'PENDING' | 'OVERDUE';

// Generate a grid of statuses
function generateGrid(): Record<string, Record<string, Status>> {
  const grid: Record<string, Record<string, Status>> = {};
  const statuses: Status[] = ['FILED', 'AUTO_VERIFIED', 'IN_PROGRESS', 'PENDING', 'OVERDUE'];

  for (const co of COMPANIES) {
    grid[co] = {};
    for (const ob of OBLIGATIONS) {
      // Mostly filed/verified, some pending/overdue
      const rand = Math.random();
      if (rand < 0.4) grid[co][ob] = 'FILED';
      else if (rand < 0.7) grid[co][ob] = 'AUTO_VERIFIED';
      else if (rand < 0.85) grid[co][ob] = 'IN_PROGRESS';
      else if (rand < 0.95) grid[co][ob] = 'PENDING';
      else grid[co][ob] = 'OVERDUE';
    }
  }
  // Force some realistic patterns
  grid['MMG']['Monthly Fin'] = 'AUTO_VERIFIED';
  grid['SCC']['Monthly Fin'] = 'AUTO_VERIFIED';
  grid['DM']['Sales Tax'] = 'OVERDUE';
  grid['AIN']['State UI'] = 'PENDING';
  return grid;
}

const GRID = generateGrid();

function StatusCell({ status }: { status: Status }) {
  const config: Record<Status, { icon: typeof Check; color: string; bg: string }> = {
    FILED: { icon: Check, color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
    AUTO_VERIFIED: { icon: CheckCircle, color: 'text-emerald-400', bg: 'bg-emerald-500/20' },
    IN_PROGRESS: { icon: Clock, color: 'text-blue-400', bg: 'bg-blue-500/10' },
    PENDING: { icon: Clock, color: 'text-amber-400', bg: 'bg-amber-500/10' },
    OVERDUE: { icon: AlertTriangle, color: 'text-red-400', bg: 'bg-red-500/10' },
  };

  const cfg = config[status];
  const Icon = cfg.icon;

  return (
    <td className="px-2 py-2 text-center">
      <div className={clsx('inline-flex h-7 w-7 items-center justify-center rounded-md', cfg.bg)} title={status}>
        <Icon size={14} className={cfg.color} />
      </div>
    </td>
  );
}

export function ComplianceGrid() {
  const allCells = COMPANIES.flatMap((co) => OBLIGATIONS.map((ob) => GRID[co][ob]));
  const filed = allCells.filter((s) => s === 'FILED' || s === 'AUTO_VERIFIED').length;
  const overdue = allCells.filter((s) => s === 'OVERDUE').length;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <MetricCard label="Filed This Month" value={String(filed)} icon={CheckCircle} />
        <MetricCard label="Due Within 7 Days" value="4" icon={Clock} />
        <MetricCard label="In Progress" value={String(allCells.filter((s) => s === 'IN_PROGRESS').length)} icon={FileText} />
        <MetricCard label="Overdue" value={String(overdue)} icon={AlertTriangle} change={overdue > 0 ? { value: 'Action required', direction: 'down' } : undefined} />
      </div>

      <div className="card overflow-x-auto">
        <div className="px-5 py-3 border-b border-slate-800">
          <h3 className="text-sm font-semibold text-white">March 2026 — Entity × Obligation</h3>
        </div>
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-800">
              <th className="px-5 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Company</th>
              {OBLIGATIONS.map((ob) => (
                <th key={ob} className="px-2 py-3 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500 whitespace-nowrap">
                  {ob}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/30">
            {COMPANIES.map((co) => (
              <tr key={co} className="table-row-hover">
                <td className="px-5 py-2">
                  <span className="text-sm text-slate-200 font-medium">{co}</span>
                </td>
                {OBLIGATIONS.map((ob) => (
                  <StatusCell key={ob} status={GRID[co][ob]} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        {/* Legend */}
        <div className="px-5 py-3 border-t border-slate-800 flex items-center gap-4 text-2xs text-slate-500">
          <span className="flex items-center gap-1"><Check size={10} className="text-emerald-400" /> Filed</span>
          <span className="flex items-center gap-1"><CheckCircle size={10} className="text-emerald-400" /> Auto-Verified</span>
          <span className="flex items-center gap-1"><Clock size={10} className="text-blue-400" /> In Progress</span>
          <span className="flex items-center gap-1"><Clock size={10} className="text-amber-400" /> Pending</span>
          <span className="flex items-center gap-1"><AlertTriangle size={10} className="text-red-400" /> Overdue</span>
        </div>
      </div>
    </div>
  );
}
