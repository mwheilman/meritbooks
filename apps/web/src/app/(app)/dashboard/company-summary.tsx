'use client';

import { StatusBadge } from '@/components/ui';

interface CompanyRow {
  id: string;
  name: string;
  shortCode: string;
  cashCents: number;
  pendingCount: number;
  closeStatus: string;
  cashStatus: string;
}

// Demo data — replace with Supabase query
const DEMO_COMPANIES: CompanyRow[] = [
  { id: '1', name: 'Merit Management Group', shortCode: 'MMG', cashCents: 8450000, pendingCount: 3, closeStatus: 'OPEN', cashStatus: 'HEALTHY' },
  { id: '2', name: 'Swan Creek Construction', shortCode: 'SCC', cashCents: 4210000, pendingCount: 8, closeStatus: 'OPEN', cashStatus: 'HEALTHY' },
  { id: '3', name: 'Iowa Custom Cabinetry', shortCode: 'ICC', cashCents: 2890000, pendingCount: 5, closeStatus: 'OPEN', cashStatus: 'ADEQUATE' },
  { id: '4', name: 'Heartland HVAC', shortCode: 'HH', cashCents: 3120000, pendingCount: 4, closeStatus: 'OPEN', cashStatus: 'HEALTHY' },
  { id: '5', name: 'Dorrian Mechanical', shortCode: 'DM', cashCents: 3554000, pendingCount: 6, closeStatus: 'OPEN', cashStatus: 'NEAR_MINIMUM' },
  { id: '6', name: 'Central Iowa Restoration', shortCode: 'CIR', cashCents: 1240000, pendingCount: 2, closeStatus: 'OPEN', cashStatus: 'ADEQUATE' },
  { id: '7', name: 'Artistry Interiors', shortCode: 'AI', cashCents: 980000, pendingCount: 7, closeStatus: 'OPEN', cashStatus: 'ADEQUATE' },
  { id: '8', name: 'Williams Insulation', shortCode: 'WI', cashCents: 1560000, pendingCount: 3, closeStatus: 'OPEN', cashStatus: 'HEALTHY' },
];

export function CompanySummaryTable() {
  return (
    <div className="card">
      <div className="px-5 py-4 border-b border-slate-800">
        <h2 className="text-sm font-semibold text-white">Portfolio Companies</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-800/50">
              <th className="px-5 py-2.5 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Company</th>
              <th className="px-5 py-2.5 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Cash</th>
              <th className="px-5 py-2.5 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500">Pending</th>
              <th className="px-5 py-2.5 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500">Status</th>
              <th className="px-5 py-2.5 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500">Close</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/30">
            {DEMO_COMPANIES.map((co) => (
              <tr key={co.id} className="table-row-hover cursor-pointer">
                <td className="px-5 py-3">
                  <div className="flex items-center gap-3">
                    <div className="h-7 w-7 rounded bg-slate-800 flex items-center justify-center text-2xs font-bold text-slate-400">
                      {co.shortCode.slice(0, 2)}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-slate-200">{co.name}</p>
                      <p className="text-2xs text-slate-500">{co.shortCode}</p>
                    </div>
                  </div>
                </td>
                <td className="px-5 py-3 text-right">
                  <span className="text-sm font-mono tabular-nums text-slate-200">
                    ${(co.cashCents / 100).toLocaleString('en-US', { minimumFractionDigits: 0 })}
                  </span>
                </td>
                <td className="px-5 py-3 text-center">
                  {co.pendingCount > 0 ? (
                    <span className="inline-flex items-center justify-center h-5 min-w-5 px-1.5 rounded-full bg-amber-500/10 text-2xs font-medium text-amber-400">
                      {co.pendingCount}
                    </span>
                  ) : (
                    <span className="text-2xs text-slate-600">—</span>
                  )}
                </td>
                <td className="px-5 py-3 text-center">
                  <StatusBadge status={co.cashStatus} />
                </td>
                <td className="px-5 py-3 text-center">
                  <StatusBadge status={co.closeStatus} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
