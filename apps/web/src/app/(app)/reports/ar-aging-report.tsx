'use client';

import React from 'react';
import { useQuery } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import { Loader2, AlertCircle } from 'lucide-react';
import { clsx } from 'clsx';

interface ArAgingRow {
  customerName: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  agingBucket: string;
  locationName: string;
}

interface ArAgingData {
  data: ArAgingRow[];
  buckets: Record<string, { count: number; totalCents: number }>;
  totalOutstanding: number;
}

const BUCKET_ORDER = ['CURRENT', '1-30', '31-60', '61-90', '90+'];
const BUCKET_COLORS: Record<string, string> = {
  CURRENT: 'bg-emerald-500', '1-30': 'bg-blue-500', '31-60': 'bg-amber-500', '61-90': 'bg-orange-500', '90+': 'bg-red-500',
};
const BUCKET_TEXT: Record<string, string> = {
  CURRENT: 'text-emerald-400', '1-30': 'text-blue-400', '31-60': 'text-amber-400', '61-90': 'text-orange-400', '90+': 'text-red-400',
};

export function ArAgingReport({ params }: { params: Record<string, string> }) {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v));
  const qs = new URLSearchParams(clean).toString();
  const { data, isLoading, error } = useQuery<ArAgingData>(`/api/reports/ar-aging${qs ? '?' + qs : ''}`);

  if (isLoading) return <div className="card p-12 flex items-center justify-center"><Loader2 size={24} className="animate-spin text-slate-500" /></div>;
  if (error) return <div className="card p-8 text-center"><AlertCircle size={24} className="mx-auto text-red-400 mb-2" /><p className="text-sm text-red-400">{String(error)}</p></div>;
  if (!data || data.data.length === 0) return <div className="card p-8 text-center text-sm text-slate-500">No outstanding receivables.</div>;

  const { data: rows, buckets, totalOutstanding } = data;
  const totalForBar = Math.max(totalOutstanding, 1);

  // Group by customer
  const custMap = new Map<string, { rows: ArAgingRow[]; totalCents: number }>();
  for (const row of rows) {
    const c = custMap.get(row.customerName);
    if (c) { c.rows.push(row); c.totalCents += row.balanceCents; }
    else custMap.set(row.customerName, { rows: [row], totalCents: row.balanceCents });
  }
  const customers = Array.from(custMap.entries()).sort((a, b) => b[1].totalCents - a[1].totalCents);

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="card p-5">
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-medium text-white">Total Receivable: <span className="font-mono text-emerald-400">{formatMoney(totalOutstanding)}</span></p>
          <p className="text-xs text-slate-500">{rows.length} invoices from {custMap.size} customers</p>
        </div>
        <div className="h-3 rounded-full overflow-hidden flex bg-slate-800 mb-3">
          {BUCKET_ORDER.map((b) => {
            const bucket = buckets[b];
            if (!bucket || bucket.totalCents === 0) return null;
            return <div key={b} className={clsx('h-full', BUCKET_COLORS[b])} style={{ width: `${(bucket.totalCents / totalForBar) * 100}%` }} />;
          })}
        </div>
        <div className="flex items-center gap-4">
          {BUCKET_ORDER.map((b) => {
            const bucket = buckets[b];
            if (!bucket) return null;
            return (
              <div key={b} className="text-center">
                <p className={clsx('text-xs font-medium', BUCKET_TEXT[b])}>{b === 'CURRENT' ? 'Current' : `${b} days`}</p>
                <p className="text-sm font-mono text-white">{formatMoney(bucket.totalCents)}</p>
                <p className="text-[10px] text-slate-600">{bucket.count} invoices</p>
              </div>
            );
          })}
        </div>
      </div>

      {/* Detail */}
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800">
              <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Customer / Invoice</th>
              <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Company</th>
              <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500 w-24">Inv Date</th>
              <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500 w-24">Due Date</th>
              {BUCKET_ORDER.map((b) => (
                <th key={b} className={clsx('px-3 py-2.5 text-right text-2xs font-semibold uppercase w-24', BUCKET_TEXT[b])}>
                  {b === 'CURRENT' ? 'Current' : b}
                </th>
              ))}
              <th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500 w-28">Balance</th>
            </tr>
          </thead>
          <tbody>
            {customers.map(([name, cd]) => (
              <React.Fragment key={name}>
                <tr className="bg-slate-800/30">
                  <td colSpan={4} className="px-4 py-2 text-xs font-semibold text-white">{name}</td>
                  {BUCKET_ORDER.map((b) => {
                    const bt = cd.rows.filter((r) => r.agingBucket === b).reduce((s, r) => s + r.balanceCents, 0);
                    return <td key={b} className={clsx('px-3 py-2 text-right text-xs font-mono', bt > 0 ? BUCKET_TEXT[b] : 'text-slate-700')}>{bt > 0 ? formatMoney(bt) : '—'}</td>;
                  })}
                  <td className="px-4 py-2 text-right text-xs font-mono font-semibold text-white">{formatMoney(cd.totalCents)}</td>
                </tr>
                {cd.rows.map((row) => (
                  <tr key={`${name}-${row.invoiceNumber}`} className="hover:bg-slate-800/20">
                    <td className="px-4 py-1.5 pl-8 text-xs text-slate-400">{row.invoiceNumber || '—'}</td>
                    <td className="px-4 py-1.5 text-xs text-slate-500">{row.locationName}</td>
                    <td className="px-4 py-1.5 text-xs font-mono text-slate-500">{row.invoiceDate}</td>
                    <td className={clsx('px-4 py-1.5 text-xs font-mono', row.agingBucket === '90+' || row.agingBucket === '61-90' ? 'text-red-400' : 'text-slate-500')}>{row.dueDate}</td>
                    {BUCKET_ORDER.map((b) => (
                      <td key={b} className="px-3 py-1.5 text-right text-xs font-mono text-slate-400">{row.agingBucket === b ? formatMoney(row.balanceCents) : ''}</td>
                    ))}
                    <td className="px-4 py-1.5 text-right text-xs font-mono text-slate-300">{formatMoney(row.balanceCents)}</td>
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-700 bg-slate-800/30">
              <td colSpan={4} className="px-4 py-2.5 text-sm font-semibold text-white">Total</td>
              {BUCKET_ORDER.map((b) => (
                <td key={b} className={clsx('px-3 py-2.5 text-right text-xs font-mono font-semibold', BUCKET_TEXT[b])}>{formatMoney(buckets[b]?.totalCents ?? 0)}</td>
              ))}
              <td className="px-4 py-2.5 text-right text-sm font-mono font-bold text-white">{formatMoney(totalOutstanding)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
