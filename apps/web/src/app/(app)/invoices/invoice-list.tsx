'use client';

import { useState } from 'react';
import { clsx } from 'clsx';
import { StatusBadge } from '@/components/ui';
import { formatMoney } from '@meritbooks/shared';

interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  customerName: string;
  jobName: string | null;
  locationCode: string;
  invoiceDate: string;
  dueDate: string;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  status: string;
  isProgressBill: boolean;
  appNumber: number | null;
  agingBucket: string;
}

const TABS = ['All', 'Sent', 'Overdue', 'Paid'] as const;

const DEMO_INVOICES: InvoiceRow[] = [
  { id: '1', invoiceNumber: 'INV-2026-0089', customerName: 'John Smith', jobName: 'Smith Kitchen Remodel', locationCode: 'SCC', invoiceDate: '2026-03-15', dueDate: '2026-04-14', totalCents: 4200000, paidCents: 4200000, balanceCents: 0, status: 'PAID', isProgressBill: true, appNumber: 3, agingBucket: 'CURRENT' },
  { id: '2', invoiceNumber: 'INV-2026-0090', customerName: 'Sarah Williams', jobName: 'Williams Master Bath', locationCode: 'ICC', invoiceDate: '2026-03-20', dueDate: '2026-04-19', totalCents: 1680000, paidCents: 0, balanceCents: 1680000, status: 'SENT', isProgressBill: true, appNumber: 4, agingBucket: 'CURRENT' },
  { id: '3', invoiceNumber: 'INV-2026-0091', customerName: 'Mike Johnson', jobName: 'Johnson HVAC Replacement', locationCode: 'HH', invoiceDate: '2026-03-25', dueDate: '2026-04-24', totalCents: 925000, paidCents: 0, balanceCents: 925000, status: 'SENT', isProgressBill: false, appNumber: null, agingBucket: 'CURRENT' },
  { id: '4', invoiceNumber: 'INV-2026-0085', customerName: 'Tom Henderson', jobName: 'Henderson Water Damage', locationCode: 'CIR', invoiceDate: '2026-02-28', dueDate: '2026-03-30', totalCents: 1280000, paidCents: 0, balanceCents: 1280000, status: 'OVERDUE', isProgressBill: true, appNumber: 2, agingBucket: '1-30' },
  { id: '5', invoiceNumber: 'INV-2026-0078', customerName: 'Parker LLC', jobName: 'Parker Office Build-Out', locationCode: 'DM', invoiceDate: '2026-02-01', dueDate: '2026-03-03', totalCents: 2400000, paidCents: 1200000, balanceCents: 1200000, status: 'PARTIALLY_PAID', isProgressBill: false, appNumber: null, agingBucket: '31-60' },
  { id: '6', invoiceNumber: 'INV-2026-0092', customerName: 'Lisa Morrison', jobName: 'Morrison Living Room', locationCode: 'AIN', invoiceDate: '2026-04-01', dueDate: '2026-05-01', totalCents: 1360000, paidCents: 0, balanceCents: 1360000, status: 'DRAFT', isProgressBill: true, appNumber: 1, agingBucket: 'CURRENT' },
];

const AGING_COLORS: Record<string, string> = {
  'CURRENT': 'text-emerald-400',
  '1-30': 'text-amber-400',
  '31-60': 'text-orange-400',
  '61-90': 'text-red-400',
  '90+': 'text-red-500 font-medium',
};

export function InvoiceList() {
  const [activeTab, setActiveTab] = useState<string>('All');

  const filtered = activeTab === 'All'
    ? DEMO_INVOICES
    : DEMO_INVOICES.filter((inv) => {
        if (activeTab === 'Overdue') return inv.status === 'OVERDUE';
        if (activeTab === 'Paid') return inv.status === 'PAID';
        if (activeTab === 'Sent') return inv.status === 'SENT';
        return true;
      });

  const totalAR = DEMO_INVOICES.reduce((s, inv) => s + inv.balanceCents, 0);

  return (
    <div>
      {/* Summary */}
      <div className="flex items-center gap-6 mb-4 text-sm">
        <span className="text-slate-400">Open AR: <span className="text-white font-medium">{formatMoney(totalAR)}</span></span>
        <span className="text-slate-700">·</span>
        <span className="text-slate-400">{DEMO_INVOICES.filter((i) => i.status === 'OVERDUE').length} overdue</span>
        <span className="text-slate-700">·</span>
        <span className="text-slate-400">{DEMO_INVOICES.filter((i) => i.isProgressBill).length} progress bills</span>
      </div>

      <div className="flex items-center gap-1 mb-4">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={clsx(
              'px-3 py-1.5 rounded-md text-sm transition-colors',
              activeTab === tab ? 'bg-slate-800 text-white font-medium' : 'text-slate-400 hover:text-slate-300',
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-800">
              <th className="px-5 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Invoice</th>
              <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Customer</th>
              <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Job</th>
              <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Due</th>
              <th className="px-4 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Total</th>
              <th className="px-4 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Balance</th>
              <th className="px-4 py-3 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500">Aging</th>
              <th className="px-4 py-3 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/30">
            {filtered.map((inv) => (
              <tr key={inv.id} className="table-row-hover cursor-pointer">
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-mono text-brand-400">{inv.invoiceNumber}</span>
                    {inv.isProgressBill && (
                      <span className="text-2xs text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded-full">
                        App #{inv.appNumber}
                      </span>
                    )}
                  </div>
                  <span className="text-2xs text-slate-500">{inv.locationCode}</span>
                </td>
                <td className="px-4 py-3 text-sm text-slate-300">{inv.customerName}</td>
                <td className="px-4 py-3 text-sm text-slate-400 truncate max-w-[160px]">{inv.jobName ?? '—'}</td>
                <td className="px-4 py-3 text-sm text-slate-400 font-mono tabular-nums">{inv.dueDate}</td>
                <td className="px-4 py-3 text-right text-sm font-mono tabular-nums text-slate-400">{formatMoney(inv.totalCents)}</td>
                <td className="px-4 py-3 text-right text-sm font-mono tabular-nums text-slate-200 font-medium">
                  {inv.balanceCents > 0 ? formatMoney(inv.balanceCents) : '—'}
                </td>
                <td className="px-4 py-3 text-center">
                  <span className={clsx('text-xs font-mono', AGING_COLORS[inv.agingBucket] ?? 'text-slate-500')}>
                    {inv.agingBucket}
                  </span>
                </td>
                <td className="px-4 py-3 text-center">
                  <StatusBadge status={inv.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
