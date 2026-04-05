'use client';

import { clsx } from 'clsx';
import { Check, Zap, Clock, Lock } from 'lucide-react';

interface CompanyClose {
  id: string;
  name: string;
  shortCode: string;
  initial: ClosePhaseStatus;
  midClose: ClosePhaseStatus;
  final: ClosePhaseStatus;
}

interface ClosePhaseStatus {
  completed: number;
  total: number;
  autoVerified: number;
  status: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETE' | 'BLOCKED';
}

const DEMO_COMPANIES: CompanyClose[] = [
  { id: '1', name: 'Merit Management Group', shortCode: 'MMG', initial: { completed: 5, total: 5, autoVerified: 3, status: 'COMPLETE' }, midClose: { completed: 4, total: 6, autoVerified: 1, status: 'IN_PROGRESS' }, final: { completed: 0, total: 4, autoVerified: 0, status: 'NOT_STARTED' } },
  { id: '2', name: 'Swan Creek Construction', shortCode: 'SCC', initial: { completed: 5, total: 5, autoVerified: 3, status: 'COMPLETE' }, midClose: { completed: 6, total: 6, autoVerified: 2, status: 'COMPLETE' }, final: { completed: 2, total: 4, autoVerified: 0, status: 'IN_PROGRESS' } },
  { id: '3', name: 'Iowa Custom Cabinetry', shortCode: 'ICC', initial: { completed: 5, total: 5, autoVerified: 3, status: 'COMPLETE' }, midClose: { completed: 3, total: 6, autoVerified: 1, status: 'IN_PROGRESS' }, final: { completed: 0, total: 4, autoVerified: 0, status: 'NOT_STARTED' } },
  { id: '4', name: 'Heartland HVAC', shortCode: 'HH', initial: { completed: 4, total: 5, autoVerified: 3, status: 'IN_PROGRESS' }, midClose: { completed: 0, total: 6, autoVerified: 0, status: 'NOT_STARTED' }, final: { completed: 0, total: 4, autoVerified: 0, status: 'NOT_STARTED' } },
  { id: '5', name: 'Dorrian Mechanical', shortCode: 'DM', initial: { completed: 3, total: 5, autoVerified: 2, status: 'BLOCKED' }, midClose: { completed: 0, total: 6, autoVerified: 0, status: 'NOT_STARTED' }, final: { completed: 0, total: 4, autoVerified: 0, status: 'NOT_STARTED' } },
  { id: '6', name: 'Central Iowa Restoration', shortCode: 'CIR', initial: { completed: 5, total: 5, autoVerified: 4, status: 'COMPLETE' }, midClose: { completed: 6, total: 6, autoVerified: 3, status: 'COMPLETE' }, final: { completed: 4, total: 4, autoVerified: 1, status: 'COMPLETE' } },
  { id: '7', name: 'Artistry Interiors', shortCode: 'AIN', initial: { completed: 5, total: 5, autoVerified: 3, status: 'COMPLETE' }, midClose: { completed: 5, total: 6, autoVerified: 2, status: 'IN_PROGRESS' }, final: { completed: 0, total: 4, autoVerified: 0, status: 'NOT_STARTED' } },
  { id: '8', name: 'Williams Insulation', shortCode: 'WI', initial: { completed: 5, total: 5, autoVerified: 4, status: 'COMPLETE' }, midClose: { completed: 6, total: 6, autoVerified: 3, status: 'COMPLETE' }, final: { completed: 3, total: 4, autoVerified: 1, status: 'IN_PROGRESS' } },
];

function PhaseCell({ phase }: { phase: ClosePhaseStatus }) {
  const pct = phase.total > 0 ? (phase.completed / phase.total) * 100 : 0;

  return (
    <td className="px-4 py-3">
      <div className="flex items-center gap-2">
        {/* Progress ring / icon */}
        <div className={clsx(
          'h-7 w-7 rounded-full flex items-center justify-center shrink-0',
          phase.status === 'COMPLETE' && 'bg-emerald-500/20',
          phase.status === 'IN_PROGRESS' && 'bg-blue-500/20',
          phase.status === 'BLOCKED' && 'bg-red-500/20',
          phase.status === 'NOT_STARTED' && 'bg-slate-800',
        )}>
          {phase.status === 'COMPLETE' && <Check size={14} className="text-emerald-400" />}
          {phase.status === 'IN_PROGRESS' && <Clock size={14} className="text-blue-400" />}
          {phase.status === 'BLOCKED' && <Lock size={14} className="text-red-400" />}
          {phase.status === 'NOT_STARTED' && <span className="text-2xs text-slate-600">—</span>}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-slate-300">{phase.completed}/{phase.total}</span>
            {phase.autoVerified > 0 && (
              <span className="flex items-center gap-0.5 text-2xs text-amber-400" title={`${phase.autoVerified} auto-verified`}>
                <Zap size={10} />
                {phase.autoVerified}
              </span>
            )}
          </div>
          {/* Progress bar */}
          <div className="h-1 rounded-full bg-slate-800 mt-1 overflow-hidden">
            <div
              className={clsx(
                'h-full rounded-full transition-all',
                phase.status === 'COMPLETE' && 'bg-emerald-500',
                phase.status === 'IN_PROGRESS' && 'bg-blue-500',
                phase.status === 'BLOCKED' && 'bg-red-500',
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      </div>
    </td>
  );
}

export function CloseGrid() {
  const totalComplete = DEMO_COMPANIES.filter((c) =>
    c.initial.status === 'COMPLETE' && c.midClose.status === 'COMPLETE' && c.final.status === 'COMPLETE'
  ).length;

  return (
    <div>
      {/* Summary stats */}
      <div className="flex items-center gap-6 mb-4 text-sm">
        <span className="text-emerald-400 font-medium">{totalComplete}/{DEMO_COMPANIES.length} fully closed</span>
        <span className="text-slate-700">·</span>
        <span className="text-slate-400">Initial due Day 3 · Mid-Close due Day 7 · Final due Day 10</span>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-800">
              <th className="px-5 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500 w-64">Company</th>
              <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">
                Initial <span className="text-slate-600 font-normal">(Day 3)</span>
              </th>
              <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">
                Mid-Close <span className="text-slate-600 font-normal">(Day 7)</span>
              </th>
              <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">
                Final <span className="text-slate-600 font-normal">(Day 10)</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/30">
            {DEMO_COMPANIES.map((co) => (
              <tr key={co.id} className="table-row-hover cursor-pointer">
                <td className="px-5 py-3">
                  <div className="flex items-center gap-3">
                    <div className="h-7 w-7 rounded bg-slate-800 flex items-center justify-center text-2xs font-bold text-slate-400">
                      {co.shortCode.slice(0, 2)}
                    </div>
                    <span className="text-sm text-slate-200">{co.name}</span>
                  </div>
                </td>
                <PhaseCell phase={co.initial} />
                <PhaseCell phase={co.midClose} />
                <PhaseCell phase={co.final} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
