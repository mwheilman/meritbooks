'use client';

import { useState } from 'react';
import { clsx } from 'clsx';
import { StatusBadge } from '@/components/ui';
import { formatMoney } from '@meritbooks/shared';

const TABS = ['All', 'Draft', 'Posted', 'Adjusting'] as const;

interface JERow {
  id: string;
  entryNumber: string;
  entryDate: string;
  entryType: string;
  memo: string;
  location: string;
  locationCode: string;
  source: string;
  status: string;
  totalDebitCents: number;
  lineCount: number;
  createdBy: string;
}

const DEMO_JES: JERow[] = [
  { id: '1', entryNumber: 'JE-2026-000851', entryDate: '2026-04-03', entryType: 'STANDARD', memo: 'Bank feed — Menards materials purchase', location: 'Swan Creek Construction', locationCode: 'SCC', source: 'BANK_FEED', status: 'POSTED', totalDebitCents: 34218, lineCount: 2, createdBy: 'System' },
  { id: '2', entryNumber: 'JE-2026-000850', entryDate: '2026-04-03', entryType: 'STANDARD', memo: 'AP payment — Carrier HVAC bill #INV-4472', location: 'Heartland HVAC', locationCode: 'HH', source: 'BILL', status: 'POSTED', totalDebitCents: 824000, lineCount: 2, createdBy: 'System' },
  { id: '3', entryNumber: 'JE-2026-000849', entryDate: '2026-04-02', entryType: 'STANDARD', memo: 'Payroll — biweekly pay period ending 3/28', location: 'Merit Management Group', locationCode: 'MMG', source: 'PAYROLL', status: 'POSTED', totalDebitCents: 4875000, lineCount: 14, createdBy: 'Sarah M.' },
  { id: '4', entryNumber: 'JE-2026-000848', entryDate: '2026-04-01', entryType: 'RECURRING', memo: 'Monthly depreciation — all entities', location: 'All Companies', locationCode: 'ALL', source: 'DEPRECIATION', status: 'POSTED', totalDebitCents: 1245000, lineCount: 34, createdBy: 'System' },
  { id: '5', entryNumber: 'JE-2026-000847', entryDate: '2026-04-01', entryType: 'ADJUSTING', memo: 'Prepaid insurance amortization — March', location: 'Merit Management Group', locationCode: 'MMG', source: 'MANUAL', status: 'DRAFT', totalDebitCents: 185000, lineCount: 4, createdBy: 'Sarah M.' },
  { id: '6', entryNumber: 'JE-2026-000846', entryDate: '2026-03-31', entryType: 'SYSTEM', memo: 'Revenue recognition — Iowa Custom Cabinetry', location: 'Iowa Custom Cabinetry', locationCode: 'ICC', source: 'REV_REC', status: 'POSTED', totalDebitCents: 1875000, lineCount: 6, createdBy: 'System' },
];

function sourceLabel(source: string): string {
  const map: Record<string, string> = {
    BANK_FEED: 'Bank Feed',
    BILL: 'AP Bill',
    RECEIPT: 'Receipt',
    PAYROLL: 'Payroll',
    MANUAL: 'Manual',
    REV_REC: 'Rev Rec',
    DEPRECIATION: 'Depreciation',
    CHARGEBACK: 'Chargeback',
    INTERCOMPANY: 'Intercompany',
  };
  return map[source] ?? source;
}

export function JournalEntryList() {
  const [activeTab, setActiveTab] = useState<string>('All');

  const filtered = activeTab === 'All'
    ? DEMO_JES
    : DEMO_JES.filter((je) => {
        if (activeTab === 'Draft') return je.status === 'DRAFT';
        if (activeTab === 'Posted') return je.status === 'POSTED';
        if (activeTab === 'Adjusting') return je.entryType === 'ADJUSTING';
        return true;
      });

  return (
    <div>
      {/* Tabs */}
      <div className="flex items-center gap-1 mb-4">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={clsx(
              'px-3 py-1.5 rounded-md text-sm transition-colors',
              activeTab === tab
                ? 'bg-slate-800 text-white font-medium'
                : 'text-slate-400 hover:text-slate-300'
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-800">
              <th className="px-5 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Entry #</th>
              <th className="px-5 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Date</th>
              <th className="px-5 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Memo</th>
              <th className="px-5 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Company</th>
              <th className="px-5 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Source</th>
              <th className="px-5 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Amount</th>
              <th className="px-5 py-3 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500">Lines</th>
              <th className="px-5 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/30">
            {filtered.map((je) => (
              <tr key={je.id} className="table-row-hover cursor-pointer">
                <td className="px-5 py-3">
                  <span className="text-sm font-mono text-brand-400">{je.entryNumber}</span>
                </td>
                <td className="px-5 py-3 text-sm text-slate-400 font-mono tabular-nums">{je.entryDate}</td>
                <td className="px-5 py-3">
                  <p className="text-sm text-slate-200 truncate max-w-xs">{je.memo}</p>
                  <p className="text-2xs text-slate-500 mt-0.5">by {je.createdBy}</p>
                </td>
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2">
                    <div className="h-5 w-5 rounded bg-slate-800 flex items-center justify-center text-2xs font-bold text-slate-500">
                      {je.locationCode.slice(0, 2)}
                    </div>
                    <span className="text-sm text-slate-300 truncate max-w-[120px]">{je.location}</span>
                  </div>
                </td>
                <td className="px-5 py-3">
                  <span className="text-xs text-slate-400 bg-slate-800 px-2 py-0.5 rounded">
                    {sourceLabel(je.source)}
                  </span>
                </td>
                <td className="px-5 py-3 text-right">
                  <span className="text-sm font-mono tabular-nums text-slate-200">
                    {formatMoney(je.totalDebitCents)}
                  </span>
                </td>
                <td className="px-5 py-3 text-center">
                  <span className="text-xs text-slate-500">{je.lineCount}</span>
                </td>
                <td className="px-5 py-3">
                  <StatusBadge status={je.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
