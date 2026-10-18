'use client';

import { useQuery } from '@/hooks';
import { formatMoney, pct } from '@meritbooks/shared';
import { Loader2, AlertCircle } from 'lucide-react';
import { clsx } from 'clsx';

interface VendorExpenseRow {
  vendorName: string;
  totalCents: number;
  billCount: number;
  locationName: string;
}

interface ExpenseByVendorData {
  data: VendorExpenseRow[];
  summary: { totalExpenseCents: number; vendorCount: number };
}

export function ExpenseByVendorReport({ params }: { params: Record<string, string> }) {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v));
  const qs = new URLSearchParams(clean).toString();
  const { data, isLoading, error } = useQuery<ExpenseByVendorData>(`/api/reports/expense-by-vendor${qs ? '?' + qs : ''}`);

  if (isLoading) return <div className="card p-12 flex items-center justify-center"><Loader2 size={24} className="animate-spin text-slate-500" /></div>;
  if (error) return <div className="card p-8 text-center"><AlertCircle size={24} className="mx-auto text-red-400 mb-2" /><p className="text-sm text-red-400">{String(error)}</p></div>;
  if (!data || data.data.length === 0) return <div className="card p-8 text-center text-sm text-slate-500">No vendor expenses in this period.</div>;

  const { data: rows, summary: s } = data;
  const totalForPct = Math.max(s.totalExpenseCents, 1);
  const maxSpend = Math.max(...rows.map((r) => r.totalCents), 1);

  // Calculate running total for concentration
  let runningTotal = 0;
  const rowsWithRunning = rows.map((r) => {
    runningTotal += r.totalCents;
    return { ...r, runningPct: pct(runningTotal, totalForPct) };
  });

  // Find top-5 concentration
  const top5Pct = rows.length >= 5
    ? pct(rows.slice(0, 5).reduce((s, r) => s + r.totalCents, 0), totalForPct)
    : 100;

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="card p-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-white">Total Vendor Spend: <span className="font-mono text-emerald-400">{formatMoney(s.totalExpenseCents)}</span></p>
            <p className="text-xs text-slate-500 mt-0.5">{s.vendorCount} vendors</p>
          </div>
          {rows.length >= 5 && (
            <div className="text-right">
              <p className="text-xs text-slate-400">Top 5 Concentration</p>
              <p className={clsx('text-lg font-mono font-semibold', top5Pct > 80 ? 'text-amber-400' : 'text-white')}>{top5Pct}%</p>
            </div>
          )}
        </div>
      </div>

      {/* Vendor table */}
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800">
              <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500 w-8">#</th>
              <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Vendor</th>
              <th className="px-4 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500 w-16">Bills</th>
              <th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500 w-28">Amount</th>
              <th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500 w-16">% Total</th>
              <th className="px-4 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500 w-48">Spend Distribution</th>
              <th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500 w-20">Cum %</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/30">
            {rowsWithRunning.map((row, idx) => {
              const spendPct = pct(row.totalCents, totalForPct);
              const barPct = (row.totalCents / maxSpend) * 100;
              return (
                <tr key={`${row.vendorName}-${idx}`} className="hover:bg-slate-800/20">
                  <td className="px-4 py-2.5 text-xs font-mono text-slate-600">{idx + 1}</td>
                  <td className="px-4 py-2.5">
                    <p className="text-sm text-white font-medium">{row.vendorName}</p>
                    {row.locationName && <p className="text-[10px] text-slate-600">{row.locationName}</p>}
                  </td>
                  <td className="px-4 py-2.5 text-center text-xs font-mono text-slate-400">{row.billCount}</td>
                  <td className="px-4 py-2.5 text-right text-sm font-mono text-white">{formatMoney(row.totalCents)}</td>
                  <td className="px-4 py-2.5 text-right text-xs font-mono text-slate-400">{spendPct}%</td>
                  <td className="px-4 py-2.5">
                    <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
                      <div className={clsx('h-full rounded-full', idx < 3 ? 'bg-emerald-500' : idx < 10 ? 'bg-blue-500' : 'bg-slate-600')}
                        style={{ width: `${barPct}%` }} />
                    </div>
                  </td>
                  <td className={clsx('px-4 py-2.5 text-right text-xs font-mono', row.runningPct >= 80 ? 'text-amber-400' : 'text-slate-500')}>
                    {row.runningPct}%
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-700 bg-slate-800/30">
              <td />
              <td className="px-4 py-2.5 text-sm font-semibold text-white">Total</td>
              <td className="px-4 py-2.5 text-center text-xs font-mono text-slate-400">
                {rows.reduce((s, r) => s + r.billCount, 0)}
              </td>
              <td className="px-4 py-2.5 text-right text-sm font-mono font-bold text-white">{formatMoney(s.totalExpenseCents)}</td>
              <td className="px-4 py-2.5 text-right text-xs font-mono text-slate-400">100%</td>
              <td />
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
