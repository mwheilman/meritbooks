'use client';

import { Repeat, Loader2, AlertCircle, Clock, Check, Pause, Calendar } from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery } from '@/hooks';
import { PageHeader } from '@/components/ui';

interface RecurringRow {
  id: string; name: string; description: string | null;
  frequency: string; startDate: string; endDate: string | null;
  nextRunDate: string | null; isReversing: boolean; isActive: boolean;
  lineCount: number; lastGeneratedAt: string | null;
  location: { id: string; name: string; short_code: string } | null;
}

interface RecurringResponse {
  data: RecurringRow[];
  summary: { total: number; active: number; dueNow: number };
}

const FREQ_LABELS: Record<string, string> = { MONTHLY: 'Monthly', QUARTERLY: 'Quarterly', ANNUALLY: 'Annually' };

export default function RecurringPage() {
  const { data, isLoading, error } = useQuery<RecurringResponse>('/api/recurring');
  const templates = data?.data ?? [];
  const summary = data?.summary;
  const now = new Date().toISOString().split('T')[0];

  if (isLoading) return <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-emerald-400 animate-spin" /></div>;
  if (error) return <div className="p-8 text-center"><AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" /><p className="text-red-400 text-sm">{error}</p></div>;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Recurring Transactions"
        description={`${summary?.active ?? 0} active templates · ${summary?.dueNow ?? 0} due to generate`}
      />

      {templates.length === 0 ? (
        <div className="card p-12 text-center">
          <Repeat className="w-10 h-10 mx-auto text-slate-700 mb-3" />
          <p className="text-sm text-slate-500">No recurring templates configured.</p>
          <p className="text-xs text-slate-600 mt-1">Set up recurring journal entries for rent, insurance, depreciation, and other periodic postings.</p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Template</th>
                <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Company</th>
                <th className="px-4 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500">Frequency</th>
                <th className="px-4 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500">Lines</th>
                <th className="px-4 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500">Next Run</th>
                <th className="px-4 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500">Last Run</th>
                <th className="px-4 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500">Flags</th>
                <th className="px-4 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/30">
              {templates.map((t) => {
                const isDue = t.isActive && t.nextRunDate && t.nextRunDate <= now;
                return (
                  <tr key={t.id} className={clsx('hover:bg-slate-800/20', isDue && 'bg-amber-500/[0.03]')}>
                    <td className="px-4 py-3">
                      <p className="text-sm text-white font-medium">{t.name}</p>
                      {t.description && <p className="text-xs text-slate-500 truncate max-w-[250px]">{t.description}</p>}
                    </td>
                    <td className="px-4 py-3">
                      {t.location ? (
                        <span className="text-xs font-mono text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded">
                          {(t.location as Record<string, unknown>).short_code as string}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3 text-center text-xs text-slate-400">{FREQ_LABELS[t.frequency] ?? t.frequency}</td>
                    <td className="px-4 py-3 text-center text-xs font-mono text-slate-500">{t.lineCount}</td>
                    <td className="px-4 py-3 text-center">
                      {t.nextRunDate ? (
                        <span className={clsx('text-xs font-mono', isDue ? 'text-amber-400 font-medium' : 'text-slate-400')}>
                          {isDue && <Clock size={10} className="inline mr-1" />}
                          {t.nextRunDate}
                        </span>
                      ) : <span className="text-xs text-slate-600">—</span>}
                    </td>
                    <td className="px-4 py-3 text-center text-xs font-mono text-slate-500">
                      {t.lastGeneratedAt ? new Date(t.lastGeneratedAt).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {t.isReversing && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-500/10 text-indigo-400">Reversing</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {t.isActive ? (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-500/10 text-emerald-400">
                          <Check size={9} /> Active
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-500/10 text-slate-500">
                          <Pause size={9} /> Paused
                        </span>
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
