'use client';

import React from 'react';
import { useQuery } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import { Loader2, AlertCircle } from 'lucide-react';
import { clsx } from 'clsx';

interface ApAgingRow {
  vendorName: string;
  billNumber: string;
  billDate: string;
  dueDate: string;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  agingBucket: string;
  locationName: string;
}

interface ApAgingData {
  data: ApAgingRow[];
  buckets: Record<string, { count: number; totalCents: number }>;
  totalOutstanding: number;
}

const BUCKET_ORDER = ['CURRENT', '1-30', '31-60', '61-90', '90+'];
const BUCKET_COLORS: Record<string, string> = {
  CURRENT: 'bg-emerald-500',
  '1-30': 'bg-blue-500',
  '31-60': 'bg-amber-500',
  '61-90': 'bg-orange-500',
  '90+': 'bg-red-500',
};
const BUCKET_TEXT: Record<string, string> = {
  CURRENT: 'text-emerald-400',
  '1-30': 'text-blue-400',
  '31-60': 'text-amber-400',
  '61-90': 'text-orange-400',
  '90+': 'text-red-400',
};

export function ApAgingReport({ params }: { params: Record<string, string> }) {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v));
  const qs = new URLSearchParams(clean).toString();
  const { data, isLoading, error } = useQuery<ApAgingData>(`/api/reports/ap-aging${qs ? '?' + qs : ''}`);

  if (isLoading) return <div className="card p-12 flex items-center justify-center"><Loader2 size={24} className="animate-spin text-slate-500" /></div>;
  if (error) return <div className="card p-8 text-center"><AlertCircle size={24} className="mx-auto text-red-400 mb-2" /><p className="text-sm text-red-400">{String(error)}</p></div>;
  if (!data || data.data.length === 0) return <div className="card p-8 text-center text-sm text-slate-500">No outstanding payables.</div>;

  const { data: rows, buckets, totalOutstanding } = data;

  // Aging distribution bar
  const totalForBar = Math.max(totalOutstanding, 1);

  // Group by vendor
  const vendorMap = new Map<string, { rows: ApAgingRow[]; totalCents: number }>();
  for (const row of rows) {
    const v = vendorMap.get(row.vendorName);
    if (v) { v.rows.push(row); v.totalCents += row.balanceCents; }
    else vendorMap.set(row.vendorName, { rows: [row], totalCents: row.balanceCents });
  }
  const vendors = Array.from(vendorMap.entries())
    .sort((a, b) => b[1].totalCents - a[1].totalCents);

  return (
    <div className="space-y-4">
      {/* Aging summary strip */}
      <div className="card p-5">
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-medium text-white">Total Outstanding: <span className="font-mono text-emerald-400">{formatMoney(totalOutstanding)}</span></p>
          <p className="text-xs text-slate-500">{rows.length} bills from {vendorMap.size} vendors</p>
        </div>

        {/* Stacked bar */}
        <div className="h-3 rounded-full overflow-hidden flex bg-slate-800 mb-3">
          {BUCKET_ORDER.map((b) => {
            const bucket = buckets[b];
            if (!bucket || bucket.totalCents === 0) return null;
            const pct = (bucket.totalCents / totalForBar) * 100;
            return <div key={b} className={clsx('h-full', BUCKET_COLORS[b])} style={{ width: `${pct}%` }} />;
          })}
        </div>

        {/* Bucket labels */}
        <div className="flex items-center gap-4">
          {BUCKET_ORDER.map((b) => {
            const bucket = buckets[b];
            if (!bucket) return null;
            return (
              <div key={b} className="text-center">
                <p className={clsx('text-xs font-medium', BUCKET_TEXT[b])}>{b === 'CURRENT' ? 'Current' : `${b} days`}</p>
                <p className="text-sm font-mono text-white">{formatMoney(bucket.totalCents)}</p>
                <p className="text-[10px] text-slate-600">{bucket.count} bills</p>
              </div>
            );
          })}
        </div>
      </div>

      {/* Detail table grouped by vendor */}
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800">
              <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Vendor / Bill</th>
              <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Company</th>
              <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500 w-24">Bill Date</th>
              <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500 w-24">Due Date</th>
              {BUCKET_ORDER.map((b) => (
                <th key={b} className={clsx('px-3 py-2.5 text-right text-2xs font-semibold uppercase', BUCKET_TEXT[b], 'w-24')}>
                  {b === 'CURRENT' ? 'Current' : b}
                </th>
              ))}
              <th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500 w-28">Balance</th>
            </tr>
          </thead>
          <tbody>
            {vendors.map(([vendorName, vendorData]) => (
              <React.Fragment key={vendorName}>
                {/* Vendor header */}
                <tr className="bg-slate-800/30">
                  <td colSpan={4} className="px-4 py-2 text-xs font-semibold text-white">{vendorName}</td>
                  {BUCKET_ORDER.map((b) => {
                    const bucketTotal = vendorData.rows
                      .filter((r) => r.agingBucket === b)
                      .reduce((s, r) => s + r.balanceCents, 0);
                    return (
                      <td key={b} className={clsx('px-3 py-2 text-right text-xs font-mono', bucketTotal > 0 ? BUCKET_TEXT[b] : 'text-slate-700')}>
                        {bucketTotal > 0 ? formatMoney(bucketTotal) : '—'}
                      </td>
                    );
                  })}
                  <td className="px-4 py-2 text-right text-xs font-mono font-semibold text-white">
                    {formatMoney(vendorData.totalCents)}
                  </td>
                </tr>
                {/* Bill rows */}
                {vendorData.rows.map((row) => (
                  <tr key={`${row.vendorName}-${row.billNumber}`} className="hover:bg-slate-800/20">
                    <td className="px-4 py-1.5 pl-8 text-xs text-slate-400">{row.billNumber || '—'}</td>
                    <td className="px-4 py-1.5 text-xs text-slate-500">{row.locationName}</td>
                    <td className="px-4 py-1.5 text-xs font-mono text-slate-500">{row.billDate}</td>
                    <td className={clsx('px-4 py-1.5 text-xs font-mono', row.agingBucket === '90+' || row.agingBucket === '61-90' ? 'text-red-400' : 'text-slate-500')}>
                      {row.dueDate}
                    </td>
                    {BUCKET_ORDER.map((b) => (
                      <td key={b} className="px-3 py-1.5 text-right text-xs font-mono text-slate-400">
                        {row.agingBucket === b ? formatMoney(row.balanceCents) : ''}
                      </td>
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
                <td key={b} className={clsx('px-3 py-2.5 text-right text-xs font-mono font-semibold', BUCKET_TEXT[b])}>
                  {formatMoney(buckets[b]?.totalCents ?? 0)}
                </td>
              ))}
              <td className="px-4 py-2.5 text-right text-sm font-mono font-bold text-white">{formatMoney(totalOutstanding)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
