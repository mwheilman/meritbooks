'use client';

import { useState } from 'react';
import { Shield, Loader2, AlertCircle, AlertTriangle, Check, Clock, Calendar } from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery } from '@/hooks';
import { PageHeader } from '@/components/ui';

interface Obligation { id: string; name: string; frequency: string; jurisdiction: string | null }
interface Filing {
  id: string; obligationId: string; locationId: string;
  periodYear: number; periodMonth: number | null; periodQuarter: number | null;
  dueDate: string; status: string;
  filedAmountCents: number | null; expectedAmountCents: number | null;
  filedAt: string | null; notes: string | null;
  location: { id: string; name: string; short_code: string } | null;
}
interface LocationRef { id: string; name: string; short_code: string }
interface ComplianceResponse {
  obligations: Obligation[];
  filings: Filing[];
  locations: LocationRef[];
  summary: { filedCount: number; overdueCount: number; upcomingCount: number; totalFilings: number };
}

const STATUS_CFG: Record<string, { label: string; cls: string; icon: typeof Check }> = {
  FILED: { label: 'Filed', cls: 'bg-emerald-500/10 text-emerald-400', icon: Check },
  AUTO_VERIFIED: { label: 'Auto ✓', cls: 'bg-cyan-500/10 text-cyan-400', icon: Check },
  PENDING: { label: 'Pending', cls: 'bg-slate-500/10 text-slate-400', icon: Clock },
  IN_PROGRESS: { label: 'In Progress', cls: 'bg-blue-500/10 text-blue-400', icon: Clock },
  OVERDUE: { label: 'Overdue', cls: 'bg-red-500/10 text-red-400', icon: AlertTriangle },
};

export default function CompliancePage() {
  const now = new Date();
  const [year] = useState(now.getFullYear());

  const { data, isLoading, error } = useQuery<ComplianceResponse>(`/api/compliance`, { year: String(year) });
  const obligations = data?.obligations ?? [];
  const filings = data?.filings ?? [];
  const locations = data?.locations ?? [];
  const summary = data?.summary;

  // Build grid: obligation → location → filing
  const getFilingStatus = (oblId: string, locId: string): Filing | null => {
    return filings.find((f) => f.obligationId === oblId && f.locationId === locId) ?? null;
  };

  if (isLoading) return <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-emerald-400 animate-spin" /></div>;
  if (error) return <div className="p-8 text-center"><AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" /><p className="text-red-400 text-sm">{error}</p></div>;

  return (
    <div className="space-y-6">
      <PageHeader title="Compliance" description={`Regulatory filing status for ${year}`} />

      {/* Summary strip */}
      <div className="flex items-center gap-6 px-4 py-3 rounded-lg bg-slate-800/30 border border-slate-800 text-sm">
        <span className="text-emerald-400 font-medium flex items-center gap-1"><Check size={13} /> {summary?.filedCount ?? 0} filed</span>
        <span className="text-amber-400 flex items-center gap-1"><Calendar size={13} /> {summary?.upcomingCount ?? 0} due within 7 days</span>
        <span className={clsx('font-medium flex items-center gap-1', (summary?.overdueCount ?? 0) > 0 ? 'text-red-400' : 'text-slate-500')}>
          <AlertTriangle size={13} /> {summary?.overdueCount ?? 0} overdue
        </span>
      </div>

      {obligations.length === 0 ? (
        <div className="card p-12 text-center">
          <Shield className="w-10 h-10 mx-auto text-slate-700 mb-3" />
          <p className="text-sm text-slate-500">No compliance obligations configured.</p>
          <p className="text-xs text-slate-600 mt-1">Add obligations (Sales Tax, State Withholding, etc.) to track filings.</p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800">
                  <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500 sticky left-0 bg-slate-950 z-10 min-w-[200px]">Obligation</th>
                  {locations.map((loc) => (
                    <th key={loc.id} className="px-3 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500 min-w-[90px]">
                      {loc.short_code}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/30">
                {obligations.map((obl) => (
                  <tr key={obl.id} className="hover:bg-slate-800/20">
                    <td className="px-4 py-3 sticky left-0 bg-slate-950 z-10">
                      <p className="text-sm text-white font-medium">{obl.name}</p>
                      <p className="text-[10px] text-slate-600">{obl.frequency} · {obl.jurisdiction ?? 'Federal'}</p>
                    </td>
                    {locations.map((loc) => {
                      const filing = getFilingStatus(obl.id, loc.id);
                      if (!filing) {
                        return <td key={loc.id} className="px-3 py-3 text-center"><span className="text-slate-700">—</span></td>;
                      }
                      const cfg = STATUS_CFG[filing.status] ?? STATUS_CFG.PENDING;
                      const Icon = cfg.icon;
                      const isOverdue = filing.status !== 'FILED' && filing.status !== 'AUTO_VERIFIED' && new Date(filing.dueDate) < now;
                      const actualCfg = isOverdue ? STATUS_CFG.OVERDUE : cfg;
                      const ActualIcon = isOverdue ? AlertTriangle : Icon;
                      return (
                        <td key={loc.id} className="px-3 py-3 text-center">
                          <span className={clsx('inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium', actualCfg.cls)}>
                            <ActualIcon size={9} /> {isOverdue ? 'Overdue' : actualCfg.label}
                          </span>
                          <p className="text-[10px] text-slate-600 font-mono mt-0.5">{filing.dueDate}</p>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
