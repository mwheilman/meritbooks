'use client';

import { clsx } from 'clsx';
import { StatusBadge, MetricCard } from '@/components/ui';
import { formatMoney } from '@meritbooks/shared';
import { CheckCircle, AlertTriangle, FileCheck, Landmark } from 'lucide-react';

interface ReconAccount {
  id: string;
  institution: string;
  accountName: string;
  mask: string;
  locationCode: string;
  statementBalance: number;
  glBalance: number;
  outstandingDeposits: number;
  outstandingChecks: number;
  adjustedBank: number;
  difference: number;
  isReconciled: boolean;
  period: string;
}

const DEMO_RECONS: ReconAccount[] = [
  { id: '1', institution: 'Bank of America', accountName: 'Operating', mask: '4418', locationCode: 'MMG', statementBalance: 6420000, glBalance: 6420000, outstandingDeposits: 0, outstandingChecks: 0, adjustedBank: 6420000, difference: 0, isReconciled: true, period: 'Mar 2026' },
  { id: '2', institution: 'Bank of America', accountName: 'Payroll', mask: '4419', locationCode: 'MMG', statementBalance: 2030000, glBalance: 2030000, outstandingDeposits: 0, outstandingChecks: 0, adjustedBank: 2030000, difference: 0, isReconciled: true, period: 'Mar 2026' },
  { id: '3', institution: 'Wells Fargo', accountName: 'Operating', mask: '7712', locationCode: 'SCC', statementBalance: 3280000, glBalance: 3480000, outstandingDeposits: 420000, outstandingChecks: 220000, adjustedBank: 3480000, difference: 0, isReconciled: true, period: 'Mar 2026' },
  { id: '4', institution: 'Wells Fargo', accountName: 'Operating', mask: '3301', locationCode: 'ICC', statementBalance: 2640000, glBalance: 2890000, outstandingDeposits: 350000, outstandingChecks: 100000, adjustedBank: 2890000, difference: 0, isReconciled: false, period: 'Mar 2026' },
  { id: '5', institution: 'US Bank', accountName: 'Operating', mask: '5504', locationCode: 'HH', statementBalance: 2980000, glBalance: 3120000, outstandingDeposits: 180000, outstandingChecks: 40000, adjustedBank: 3120000, difference: 0, isReconciled: false, period: 'Mar 2026' },
  { id: '6', institution: 'US Bank', accountName: 'Operating', mask: '8820', locationCode: 'DM', statementBalance: 3400000, glBalance: 3554000, outstandingDeposits: 200000, outstandingChecks: 46000, adjustedBank: 3554000, difference: 0, isReconciled: false, period: 'Mar 2026' },
  { id: '7', institution: 'Hills Bank', accountName: 'Operating', mask: '2210', locationCode: 'CIR', statementBalance: 1190000, glBalance: 1240000, outstandingDeposits: 80000, outstandingChecks: 30000, adjustedBank: 1240000, difference: 0, isReconciled: false, period: 'Mar 2026' },
  { id: '8', institution: 'Hills Bank', accountName: 'Operating', mask: '1180', locationCode: 'WI', statementBalance: 1480000, glBalance: 1560000, outstandingDeposits: 120000, outstandingChecks: 40000, adjustedBank: 1560000, difference: 0, isReconciled: false, period: 'Mar 2026' },
];

export function ReconciliationView() {
  const reconciled = DEMO_RECONS.filter((r) => r.isReconciled).length;
  const total = DEMO_RECONS.length;
  const unreconciled = total - reconciled;
  const hasDiscrepancies = DEMO_RECONS.some((r) => r.difference !== 0);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <MetricCard label="Reconciled" value={`${reconciled}/${total}`} icon={CheckCircle} change={{ value: 'March 2026', direction: 'flat' }} />
        <MetricCard label="Outstanding" value={String(unreconciled)} icon={FileCheck} />
        <MetricCard label="Total Accounts" value={String(total)} icon={Landmark} />
        <MetricCard label="Discrepancies" value={hasDiscrepancies ? 'Yes' : 'None'} icon={AlertTriangle} change={hasDiscrepancies ? { value: 'Action needed', direction: 'down' } : { value: 'All clear', direction: 'up' }} />
      </div>

      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-800">
          <h3 className="text-sm font-semibold text-white">March 2026 Reconciliations</h3>
        </div>
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-800">
              <th className="px-5 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Account</th>
              <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Entity</th>
              <th className="px-4 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Statement</th>
              <th className="px-4 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">+ Deposits</th>
              <th className="px-4 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">− Checks</th>
              <th className="px-4 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Adj. Bank</th>
              <th className="px-4 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">GL Balance</th>
              <th className="px-4 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Diff</th>
              <th className="px-4 py-3 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/30">
            {DEMO_RECONS.map((r) => (
              <tr key={r.id} className="table-row-hover cursor-pointer">
                <td className="px-5 py-3">
                  <p className="text-sm text-slate-200">{r.institution}</p>
                  <p className="text-2xs text-slate-500">{r.accountName} ·{r.mask}</p>
                </td>
                <td className="px-4 py-3">
                  <span className="text-sm text-slate-300">{r.locationCode}</span>
                </td>
                <td className="px-4 py-3 text-right text-sm font-mono tabular-nums text-slate-400">{formatMoney(r.statementBalance)}</td>
                <td className="px-4 py-3 text-right text-sm font-mono tabular-nums text-emerald-400/70">
                  {r.outstandingDeposits > 0 ? `+${formatMoney(r.outstandingDeposits)}` : '—'}
                </td>
                <td className="px-4 py-3 text-right text-sm font-mono tabular-nums text-red-400/70">
                  {r.outstandingChecks > 0 ? `(${formatMoney(r.outstandingChecks)})` : '—'}
                </td>
                <td className="px-4 py-3 text-right text-sm font-mono tabular-nums text-slate-300">{formatMoney(r.adjustedBank)}</td>
                <td className="px-4 py-3 text-right text-sm font-mono tabular-nums text-slate-300">{formatMoney(r.glBalance)}</td>
                <td className="px-4 py-3 text-right">
                  <span className={clsx(
                    'text-sm font-mono tabular-nums font-medium',
                    r.difference === 0 ? 'text-emerald-400' : 'text-red-400',
                  )}>
                    {r.difference === 0 ? '$0.00' : formatMoney(r.difference)}
                  </span>
                </td>
                <td className="px-4 py-3 text-center">
                  {r.isReconciled
                    ? <StatusBadge status="COMPLETE" variant="success" />
                    : <StatusBadge status="PENDING" />
                  }
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
