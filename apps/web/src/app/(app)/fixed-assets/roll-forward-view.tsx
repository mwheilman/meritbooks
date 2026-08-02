'use client';

import { useState } from 'react';
import { Loader2, AlertCircle, FileText } from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';

interface RollForwardRow {
  className: string;
  begCostCents: number; additionsCents: number; disposalsCostCents: number; endCostCents: number;
  begAccumCents: number; depreciationCents: number; disposalsAccumCents: number; endAccumCents: number;
  begNbvCents: number; endNbvCents: number;
}
interface RollForwardResponse {
  periodStart: string; periodEnd: string;
  classes: RollForwardRow[];
  total: RollForwardRow;
}

const num = (c: number) => formatMoney(c);
const signed = (c: number) => (c === 0 ? '—' : c < 0 ? `(${formatMoney(-c)})` : formatMoney(c));

function Row({ r, bold }: { r: RollForwardRow; bold?: boolean }) {
  return (
    <tr className={clsx('border-b border-slate-800/40', bold && 'bg-slate-800/30 font-semibold')}>
      <td className={clsx('px-3 py-2 text-xs', bold ? 'text-white' : 'text-slate-300')}>{r.className}</td>
      <td className="px-3 py-2 text-right text-xs font-mono text-slate-300">{num(r.begCostCents)}</td>
      <td className="px-3 py-2 text-right text-xs font-mono text-emerald-400">{r.additionsCents ? num(r.additionsCents) : '—'}</td>
      <td className="px-3 py-2 text-right text-xs font-mono text-red-400">{r.disposalsCostCents ? `(${num(r.disposalsCostCents)})` : '—'}</td>
      <td className="px-3 py-2 text-right text-xs font-mono text-white">{num(r.endCostCents)}</td>
      <td className="px-3 py-2 text-right text-xs font-mono text-amber-400">{num(r.begAccumCents)}</td>
      <td className="px-3 py-2 text-right text-xs font-mono text-amber-400">{r.depreciationCents ? num(r.depreciationCents) : '—'}</td>
      <td className="px-3 py-2 text-right text-xs font-mono text-slate-400">{r.disposalsAccumCents ? `(${num(r.disposalsAccumCents)})` : '—'}</td>
      <td className="px-3 py-2 text-right text-xs font-mono text-amber-400">{num(r.endAccumCents)}</td>
      <td className="px-3 py-2 text-right text-xs font-mono font-medium text-emerald-400">{num(r.endNbvCents)}</td>
    </tr>
  );
}

export function RollForwardView() {
  const year = new Date().getUTCFullYear();
  const [periodStart, setPeriodStart] = useState(`${year}-01-01`);
  const [periodEnd, setPeriodEnd] = useState(`${year}-12-31`);

  const { data, isLoading, error } = useQuery<RollForwardResponse>('/api/fixed-assets/roll-forward', {
    periodStart,
    periodEnd,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-2xs uppercase text-slate-500 mb-1">Period start</label>
          <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)}
            className="px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white" />
        </div>
        <div>
          <label className="block text-2xs uppercase text-slate-500 mb-1">Period end</label>
          <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)}
            className="px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white" />
        </div>
        <p className="text-2xs text-slate-500 ml-auto max-w-xs">
          Continuity schedule — cost from the asset register, depreciation from posted GL runs.
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-emerald-400 animate-spin" /></div>
      ) : error ? (
        <div className="card p-8 text-center"><AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" /><p className="text-red-400 text-sm">{error}</p></div>
      ) : !data || data.classes.length === 0 ? (
        <div className="card p-12 text-center">
          <FileText className="w-10 h-10 mx-auto text-slate-700 mb-3" />
          <p className="text-sm text-slate-500">No fixed-asset activity in this period.</p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-900/40">
                  <th className="px-3 py-2 text-left text-2xs font-semibold uppercase text-slate-500">Asset class</th>
                  <th className="px-3 py-2 text-right text-2xs font-semibold uppercase text-slate-500">Beg cost</th>
                  <th className="px-3 py-2 text-right text-2xs font-semibold uppercase text-slate-500">Additions</th>
                  <th className="px-3 py-2 text-right text-2xs font-semibold uppercase text-slate-500">Disposals</th>
                  <th className="px-3 py-2 text-right text-2xs font-semibold uppercase text-slate-500">End cost</th>
                  <th className="px-3 py-2 text-right text-2xs font-semibold uppercase text-slate-500">Beg accum</th>
                  <th className="px-3 py-2 text-right text-2xs font-semibold uppercase text-slate-500">Depreciation</th>
                  <th className="px-3 py-2 text-right text-2xs font-semibold uppercase text-slate-500">Disp. accum</th>
                  <th className="px-3 py-2 text-right text-2xs font-semibold uppercase text-slate-500">End accum</th>
                  <th className="px-3 py-2 text-right text-2xs font-semibold uppercase text-slate-500">End NBV</th>
                </tr>
              </thead>
              <tbody>
                {data.classes.map((r) => <Row key={r.className} r={r} />)}
                <Row r={data.total} bold />
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
