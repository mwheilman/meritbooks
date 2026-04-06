'use client';

import { useState } from 'react';
import { Users, Loader2, AlertCircle, Search, Briefcase, Clock } from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import { PageHeader } from '@/components/ui';

interface EmployeeRow {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  laborType: string;
  title: string | null;
  hireDate: string | null;
  isActive: boolean;
  hourlyRateCents: number | null;
  annualSalaryCents: number | null;
  weeklyTargetHours: number | null;
  consecutiveLowPeriods: number;
  assignedLocationCount: number;
  department: { id: string; name: string; code: string } | null;
  directAssignedTarget: { id: string; name: string; short_code: string } | null;
}

interface TeamResponse {
  data: EmployeeRow[];
  summary: { total: number; active: number; byLaborType: Record<string, number> };
}

const LABOR_LABELS: Record<string, { label: string; cls: string }> = {
  PRODUCTION: { label: 'Production', cls: 'text-emerald-400 bg-emerald-500/10' },
  OVERHEAD: { label: 'Overhead', cls: 'text-slate-400 bg-slate-500/10' },
  DIRECT_ASSIGNED: { label: 'Direct Assigned', cls: 'text-blue-400 bg-blue-500/10' },
  OWNER_GROUP: { label: 'Owner', cls: 'text-purple-400 bg-purple-500/10' },
  DEAL_TEAM: { label: 'Deal Team', cls: 'text-amber-400 bg-amber-500/10' },
};

export default function TeamPage() {
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');

  const { data, isLoading, error } = useQuery<TeamResponse>('/api/team');
  const employees = data?.data ?? [];
  const summary = data?.summary;

  const filtered = employees.filter((e) => {
    if (typeFilter && e.laborType !== typeFilter) return false;
    if (search) {
      const s = search.toLowerCase();
      return e.fullName.toLowerCase().includes(s) || (e.email ?? '').toLowerCase().includes(s) || (e.title ?? '').toLowerCase().includes(s);
    }
    return true;
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Team"
        description={`${summary?.active ?? 0} active employees · ${summary?.total ?? 0} total`}
      />

      {/* Labor type badges */}
      {summary && (
        <div className="flex items-center gap-3">
          {Object.entries(summary.byLaborType).map(([type, count]) => {
            const cfg = LABOR_LABELS[type] ?? { label: type, cls: 'text-slate-400 bg-slate-500/10' };
            return (
              <button
                key={type}
                onClick={() => setTypeFilter(typeFilter === type ? '' : type)}
                className={clsx(
                  'px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
                  typeFilter === type
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                    : 'border-slate-800 bg-slate-800/30 text-slate-400 hover:border-slate-700'
                )}
              >
                {cfg.label} <span className="font-mono ml-1">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Search */}
      <div className="relative max-w-md">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, email, or title..."
          className="w-full pl-9 pr-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder:text-slate-500"
        />
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-emerald-400 animate-spin" /></div>
      ) : error ? (
        <div className="p-8 text-center"><AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" /><p className="text-sm text-red-400">{error}</p></div>
      ) : filtered.length === 0 ? (
        <div className="card p-12 text-center text-sm text-slate-500">
          {search || typeFilter ? 'No employees match your filters.' : 'No employees found. Add team members in settings.'}
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Name</th>
                <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Title</th>
                <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Department</th>
                <th className="px-4 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500">Labor Type</th>
                <th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500">Rate</th>
                <th className="px-4 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500">Target Hrs</th>
                <th className="px-4 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500">Companies</th>
                <th className="px-4 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/30">
              {filtered.map((emp) => {
                const ltCfg = LABOR_LABELS[emp.laborType] ?? { label: emp.laborType, cls: 'text-slate-400 bg-slate-500/10' };
                const hasLowUtil = emp.consecutiveLowPeriods >= 2;
                return (
                  <tr key={emp.id} className={clsx('hover:bg-slate-800/20', hasLowUtil && 'bg-red-500/[0.03]')}>
                    <td className="px-4 py-3">
                      <p className="text-sm text-white font-medium">{emp.fullName}</p>
                      {emp.email && <p className="text-xs text-slate-500">{emp.email}</p>}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-400">{emp.title ?? '—'}</td>
                    <td className="px-4 py-3">
                      {emp.department ? (
                        <span className="text-xs font-mono text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded">{(emp.department as Record<string, unknown>).code as string}</span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={clsx('inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium', ltCfg.cls)}>
                        {ltCfg.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-xs font-mono text-slate-300">
                      {emp.hourlyRateCents
                        ? `${formatMoney(emp.hourlyRateCents)}/hr`
                        : emp.annualSalaryCents
                          ? `${formatMoney(emp.annualSalaryCents, { compact: true })}/yr`
                          : '—'}
                    </td>
                    <td className="px-4 py-3 text-center text-xs font-mono text-slate-400">
                      {emp.weeklyTargetHours ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-center text-xs font-mono text-slate-400">
                      {emp.assignedLocationCount}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {hasLowUtil ? (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-500/10 text-red-400">
                          <Clock size={9} /> Low Util
                        </span>
                      ) : emp.isActive ? (
                        <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-500/10 text-emerald-400">Active</span>
                      ) : (
                        <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-500/10 text-slate-500">Inactive</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
