'use client';

import { useState } from 'react';
import { clsx } from 'clsx';
import { AlertTriangle, Shield } from 'lucide-react';
import { StatusBadge } from '@/components/ui';
import { formatMoney } from '@meritbooks/shared';

interface BillRow {
  id: string;
  vendorName: string;
  billNumber: string;
  billDate: string;
  dueDate: string;
  totalCents: number;
  balanceCents: number;
  status: string;
  locationName: string;
  locationCode: string;
  aiExtracted: boolean;
  aiConfidence: number | null;
  agingBucket: string;
  complianceWarning: string | null;
}

const TABS = ['All', 'Pending', 'Approved', 'Overdue', 'On Hold'] as const;

const DEMO_BILLS: BillRow[] = [
  { id: '1', vendorName: 'Carrier HVAC', billNumber: 'INV-4472', billDate: '2026-03-28', dueDate: '2026-04-27', totalCents: 824000, balanceCents: 824000, status: 'APPROVED', locationName: 'Heartland HVAC', locationCode: 'HH', aiExtracted: true, aiConfidence: 0.97, agingBucket: 'CURRENT', complianceWarning: null },
  { id: '2', vendorName: 'ABC Electric', billNumber: 'E-2026-118', billDate: '2026-03-15', dueDate: '2026-04-14', totalCents: 480000, balanceCents: 480000, status: 'ON_HOLD', locationName: 'Swan Creek', locationCode: 'SCC', aiExtracted: true, aiConfidence: 0.91, agingBucket: 'CURRENT', complianceWarning: 'GL COI expired 3/10/2026' },
  { id: '3', vendorName: 'Grainger', billNumber: '9847231', billDate: '2026-03-20', dueDate: '2026-04-19', totalCents: 342100, balanceCents: 342100, status: 'PENDING', locationName: 'Merit Mgmt', locationCode: 'MMG', aiExtracted: true, aiConfidence: 0.88, agingBucket: 'CURRENT', complianceWarning: null },
  { id: '4', vendorName: 'Fastenal', billNumber: 'IAINV-88421', billDate: '2026-02-28', dueDate: '2026-03-30', totalCents: 189400, balanceCents: 189400, status: 'APPROVED', locationName: 'Dorrian Mech', locationCode: 'DM', aiExtracted: false, aiConfidence: null, agingBucket: '1-30', complianceWarning: null },
  { id: '5', vendorName: 'Smith Plumbing', billNumber: 'SP-2026-044', billDate: '2026-02-10', dueDate: '2026-03-12', totalCents: 124000, balanceCents: 124000, status: 'ON_HOLD', locationName: 'Iowa Custom', locationCode: 'ICC', aiExtracted: true, aiConfidence: 0.85, agingBucket: '31-60', complianceWarning: 'W-9 missing, GL COI missing, WC COI missing' },
  { id: '6', vendorName: 'Ferguson HVAC', billNumber: 'FH-99102', billDate: '2026-03-25', dueDate: '2026-04-24', totalCents: 1240000, balanceCents: 620000, status: 'PARTIALLY_PAID', locationName: 'Heartland HVAC', locationCode: 'HH', aiExtracted: true, aiConfidence: 0.95, agingBucket: 'CURRENT', complianceWarning: null },
  { id: '7', vendorName: 'Lennox', billNumber: 'L-2026-2847', billDate: '2026-01-15', dueDate: '2026-02-14', totalCents: 2480000, balanceCents: 2480000, status: 'APPROVED', locationName: 'Midwest Comfort', locationCode: 'MC', aiExtracted: true, aiConfidence: 0.93, agingBucket: '90+', complianceWarning: null },
];

const AGING_COLORS: Record<string, string> = {
  'CURRENT': 'text-emerald-400',
  '1-30': 'text-amber-400',
  '31-60': 'text-orange-400',
  '61-90': 'text-red-400',
  '90+': 'text-red-500 font-medium',
};

export function BillList() {
  const [activeTab, setActiveTab] = useState<string>('All');

  const filtered = activeTab === 'All'
    ? DEMO_BILLS
    : DEMO_BILLS.filter((b) => {
        if (activeTab === 'Overdue') return ['1-30', '31-60', '61-90', '90+'].includes(b.agingBucket);
        if (activeTab === 'On Hold') return b.status === 'ON_HOLD';
        return b.status === activeTab.toUpperCase();
      });

  const totalOpen = DEMO_BILLS.reduce((s, b) => s + b.balanceCents, 0);
  const overdue = DEMO_BILLS.filter((b) => b.agingBucket !== 'CURRENT').reduce((s, b) => s + b.balanceCents, 0);

  return (
    <div>
      {/* Summary row */}
      <div className="flex items-center gap-6 mb-4 text-sm">
        <span className="text-slate-400">Open AP: <span className="text-white font-medium">{formatMoney(totalOpen)}</span></span>
        <span className="text-slate-700">·</span>
        <span className="text-slate-400">Overdue: <span className="text-red-400 font-medium">{formatMoney(overdue)}</span></span>
        <span className="text-slate-700">·</span>
        <span className="text-slate-400">On Hold: <span className="text-amber-400 font-medium">{DEMO_BILLS.filter((b) => b.status === 'ON_HOLD').length} bills</span></span>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-4">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={clsx(
              'px-3 py-1.5 rounded-md text-sm transition-colors',
              activeTab === tab ? 'bg-slate-800 text-white font-medium' : 'text-slate-400 hover:text-slate-300'
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
              <th className="px-5 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Vendor</th>
              <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Bill #</th>
              <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Company</th>
              <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Due</th>
              <th className="px-4 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Total</th>
              <th className="px-4 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Balance</th>
              <th className="px-4 py-3 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500">Aging</th>
              <th className="px-4 py-3 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/30">
            {filtered.map((bill) => (
              <tr key={bill.id} className="table-row-hover cursor-pointer">
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-200">{bill.vendorName}</span>
                    {bill.complianceWarning && (
                      <span title={bill.complianceWarning}>
                        <Shield size={14} className="text-red-400" />
                      </span>
                    )}
                  </div>
                  {bill.complianceWarning && (
                    <p className="text-2xs text-red-400 mt-0.5 flex items-center gap-1">
                      <AlertTriangle size={10} />
                      {bill.complianceWarning}
                    </p>
                  )}
                </td>
                <td className="px-4 py-3 text-sm font-mono text-slate-400">{bill.billNumber}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className="h-5 w-5 rounded bg-slate-800 flex items-center justify-center text-2xs font-bold text-slate-500">
                      {bill.locationCode.slice(0, 2)}
                    </div>
                    <span className="text-sm text-slate-300">{bill.locationName}</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-sm text-slate-400 font-mono tabular-nums">{bill.dueDate}</td>
                <td className="px-4 py-3 text-right text-sm font-mono tabular-nums text-slate-400">{formatMoney(bill.totalCents)}</td>
                <td className="px-4 py-3 text-right text-sm font-mono tabular-nums text-slate-200 font-medium">{formatMoney(bill.balanceCents)}</td>
                <td className="px-4 py-3 text-center">
                  <span className={clsx('text-xs font-mono', AGING_COLORS[bill.agingBucket] ?? 'text-slate-500')}>
                    {bill.agingBucket}
                  </span>
                </td>
                <td className="px-4 py-3 text-center">
                  <StatusBadge status={bill.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
