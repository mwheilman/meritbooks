'use client';

import { clsx } from 'clsx';
import { MetricCard } from '@/components/ui';
import { Users, Zap, Clock, TrendingUp } from 'lucide-react';

interface TeamMember {
  name: string;
  role: string;
  txnVolume: number;
  dollarVolumeCents: number;
  companiesManaged: number;
  avgProcessingMinutes: number;
  status: 'ON_FIRE' | 'ON_TRACK' | 'IMPROVING' | 'BEHIND';
}

const DEMO_TEAM: TeamMember[] = [
  { name: 'Sarah Mitchell', role: 'Sr. Accountant', txnVolume: 342, dollarVolumeCents: 284000000, companiesManaged: 6, avgProcessingMinutes: 2.1, status: 'ON_FIRE' },
  { name: 'Jake Thompson', role: 'Accountant', txnVolume: 218, dollarVolumeCents: 156000000, companiesManaged: 4, avgProcessingMinutes: 3.4, status: 'ON_TRACK' },
  { name: 'Lisa Chen', role: 'Accountant', txnVolume: 196, dollarVolumeCents: 142000000, companiesManaged: 4, avgProcessingMinutes: 2.8, status: 'ON_TRACK' },
  { name: 'Marcus Williams', role: 'Accountant', txnVolume: 164, dollarVolumeCents: 98000000, companiesManaged: 3, avgProcessingMinutes: 4.2, status: 'IMPROVING' },
  { name: 'Amy Rodriguez', role: 'Jr. Accountant', txnVolume: 128, dollarVolumeCents: 72000000, companiesManaged: 2, avgProcessingMinutes: 5.1, status: 'BEHIND' },
];

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  ON_FIRE: { label: '🔥 On Fire', color: 'text-orange-400', bg: 'bg-orange-500/10' },
  ON_TRACK: { label: '✓ On Track', color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  IMPROVING: { label: '↗ Improving', color: 'text-blue-400', bg: 'bg-blue-500/10' },
  BEHIND: { label: '↓ Behind', color: 'text-red-400', bg: 'bg-red-500/10' },
};

export function TeamDashboard() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <MetricCard label="Team Size" value="5" icon={Users} />
        <MetricCard label="Avg Processing" value="3.5 min" icon={Clock} change={{ value: '-18%', direction: 'up', label: 'vs last month' }} />
        <MetricCard label="AI Assist Rate" value="78%" icon={Zap} change={{ value: '+4%', direction: 'up', label: 'auto-categorized' }} />
        <MetricCard label="Total Processed" value="1,048" icon={TrendingUp} change={{ value: 'This month', direction: 'flat' }} />
      </div>

      <div className="card overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-800">
          <h3 className="text-sm font-semibold text-white">Stack Rankings — March 2026</h3>
        </div>
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-800">
              <th className="px-5 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500 w-8">#</th>
              <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Name</th>
              <th className="px-4 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Transactions</th>
              <th className="px-4 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Dollar Volume</th>
              <th className="px-4 py-3 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500">Companies</th>
              <th className="px-4 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Avg Time</th>
              <th className="px-4 py-3 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/30">
            {DEMO_TEAM.map((member, i) => {
              const cfg = STATUS_CONFIG[member.status];
              return (
                <tr key={member.name} className="table-row-hover">
                  <td className="px-5 py-3 text-sm font-mono text-slate-500">{i + 1}</td>
                  <td className="px-4 py-3">
                    <p className="text-sm font-medium text-slate-200">{member.name}</p>
                    <p className="text-2xs text-slate-500">{member.role}</p>
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-mono tabular-nums text-slate-300">{member.txnVolume}</td>
                  <td className="px-4 py-3 text-right text-sm font-mono tabular-nums text-slate-300">
                    ${(member.dollarVolumeCents / 100000000).toFixed(1)}M
                  </td>
                  <td className="px-4 py-3 text-center text-sm text-slate-400">{member.companiesManaged}</td>
                  <td className="px-4 py-3 text-right text-sm font-mono tabular-nums text-slate-300">{member.avgProcessingMinutes.toFixed(1)}m</td>
                  <td className="px-4 py-3 text-center">
                    <span className={clsx('inline-flex items-center px-2 py-0.5 rounded-full text-2xs font-medium', cfg.bg, cfg.color)}>
                      {cfg.label}
                    </span>
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
