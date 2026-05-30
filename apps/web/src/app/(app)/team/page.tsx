'use client';

import { useState } from 'react';
import { Loader2, AlertCircle, Search } from 'lucide-react';
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
  title: string | null;
  hireDate: string | null;
  terminationDate: string | null;
  isActive: boolean;
  hourlyRateCents: number | null;
  annualSalaryCents: number | null;
  department: { id: string; name: string; code: string } | null;
}

interface TeamResponse {
  data: EmployeeRow[];
  summary: { total: number; active: number };
}

type StatusFilter = 'all' | 'active' | 'inactive';

export default function TeamPage() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');

  const { data, isLoading, error } = useQuery<TeamResponse>('/api/team');
  const employees = data?.data ?? [];
  const summary = data?.summary;

  const filtered = employees.filter((e) => {
    if (statusFilter === 'active' && !e.isActive) return false;
    if (statusFilter === 'inactive' && e.isActive) return false;
    if (search) {
      const s = search.toLowerCase();
      return (
        e.fullName.toLowerCase().includes(s) ||
        (e.email ?? '').toLowerCase().includes(s) ||
        (e.title ?? '').toLowerCase().includes(s)
      );
    }
    return true;
  });

  const STATUS_TABS: { key: StatusFilter; label: string }[] = [
    { key: 'active', label: 'Active' },
    { key: 'inactive', label: 'Inactive' },
    { key: 'all', label: 'All' },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Team"
        description={`${summary?.active ?? 0} active · ${summary?.total ?? 0} total`}
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-800/30 p-0.5">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setStatusFilter(tab.key)}
              className={clsx(
                'px-3 py-1 rounded-md text-xs font-medium transition-colors',
                statusFilter === tab.key
                  ? 'bg-emerald-500/10 text-emerald-400'
                  : 'text-slate-400 hover:text-slate-200'
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="relative max-w-md flex-1 min-w-[220px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, email, or title..."
            className="w-full pl-9 pr-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder:text-slate-500"
          />
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-emerald-400 animate-spin" /></div>
      ) : error ? (
        <div className="p-8 text-center"><AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" /><p className="text-sm text-red-400">{error}</p></div>
      ) : filtered.length === 0 ? (
        <div className="card p-12 text-center text-sm text-slate-500">
          {search || statusFilter !== 'all' ? 'No team members match your filters.' : 'No team members yet. Invite people from Settings.'}
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Name</th>
                <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Title</th>
                <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Department</th>
                <th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500">Rate</th>
                <th className="px-4 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/30">
              {filtered.map((emp) => (
                <tr key={emp.id} className="hover:bg-slate-800/20">
                  <td className="px-4 py-3">
                    <p className="text-sm text-white font-medium">{emp.fullName}</p>
                    {emp.email && <p className="text-xs text-slate-500">{emp.email}</p>}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400">{emp.title ?? '—'}</td>
                  <td className="px-4 py-3">
                    {emp.department ? (
                      <span className="text-xs font-mono text-slate-400 bg-slate-800 px-1.5 py-0.5 rounded">{emp.department.code}</span>
                    ) : '—'}
                  </td>
                  <td className="px-4 py-3 text-right text-xs font-mono text-slate-300">
                    {emp.hourlyRateCents
                      ? `${formatMoney(emp.hourlyRateCents)}/hr`
                      : emp.annualSalaryCents
                        ? `${formatMoney(emp.annualSalaryCents, { compact: true })}/yr`
                        : '—'}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {emp.isActive ? (
                      <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-500/10 text-emerald-400">Active</span>
                    ) : (
                      <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-500/10 text-slate-500">Inactive</span>
                    )}
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
