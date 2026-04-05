'use client';

import { Sparkles } from 'lucide-react';
import { clsx } from 'clsx';
import { StatusBadge, MetricCard } from '@/components/ui';
import { formatMoney } from '@meritbooks/shared';
import { Wallet, TrendingUp, TrendingDown, AlertTriangle } from 'lucide-react';

interface CashRow {
  company: string;
  code: string;
  accounts: { name: string; mask: string; balanceCents: number }[];
  totalCents: number;
  minimumCents: number;
  status: string;
}

const DEMO_CASH: CashRow[] = [
  { company: 'Merit Management Group', code: 'MMG', accounts: [{ name: 'Operating', mask: '4418', balanceCents: 6420000 }, { name: 'Payroll', mask: '4419', balanceCents: 2030000 }], totalCents: 8450000, minimumCents: 5000000, status: 'HEALTHY' },
  { company: 'Swan Creek Construction', code: 'SCC', accounts: [{ name: 'Operating', mask: '7712', balanceCents: 3480000 }, { name: 'Escrow', mask: '7714', balanceCents: 730000 }], totalCents: 4210000, minimumCents: 3000000, status: 'HEALTHY' },
  { company: 'Iowa Custom Cabinetry', code: 'ICC', accounts: [{ name: 'Operating', mask: '3301', balanceCents: 2890000 }], totalCents: 2890000, minimumCents: 3000000, status: 'NEAR_MINIMUM' },
  { company: 'Heartland HVAC', code: 'HH', accounts: [{ name: 'Operating', mask: '5504', balanceCents: 3120000 }], totalCents: 3120000, minimumCents: 3000000, status: 'ADEQUATE' },
  { company: 'Dorrian Mechanical', code: 'DM', accounts: [{ name: 'Operating', mask: '8820', balanceCents: 3554000 }], totalCents: 3554000, minimumCents: 3000000, status: 'HEALTHY' },
  { company: 'Central Iowa Restoration', code: 'CIR', accounts: [{ name: 'Operating', mask: '2210', balanceCents: 1240000 }], totalCents: 1240000, minimumCents: 2000000, status: 'CRITICAL' },
  { company: 'Artistry Interiors', code: 'AIN', accounts: [{ name: 'Operating', mask: '6601', balanceCents: 980000 }], totalCents: 980000, minimumCents: 1500000, status: 'CRITICAL' },
  { company: 'Williams Insulation', code: 'WI', accounts: [{ name: 'Operating', mask: '1180', balanceCents: 1560000 }], totalCents: 1560000, minimumCents: 1500000, status: 'ADEQUATE' },
];

const AI_INSIGHTS = [
  { type: 'warning', text: 'Dorrian is $5,540 above its $30K minimum. Payroll ($12,400) hits Wednesday. Recommend intercompany transfer of $15K from Heartland or delay vendor payment to Carrier HVAC.' },
  { type: 'info', text: 'Swan Creek received $42K draw from Smith (Kitchen Remodel). AR aging now at 24 days avg, down from 31 last month.' },
  { type: 'warning', text: 'CIR and Artistry are both below minimum cash. Combined shortfall is $1,280. Two customer payments expected this week ($18K, $12K) should resolve.' },
  { type: 'success', text: 'Overall portfolio cash position improved 3.2% week-over-week. 13-week forecast accuracy holding at 99.2%.' },
];

export function CashDashboard() {
  const totalCash = DEMO_CASH.reduce((s, c) => s + c.totalCents, 0);
  const criticalCount = DEMO_CASH.filter((c) => c.status === 'CRITICAL').length;

  return (
    <div className="space-y-6">
      {/* KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <MetricCard label="Total Cash" value={formatMoney(totalCash, { compact: true })} icon={Wallet} change={{ value: '+$12.4K', direction: 'up', label: 'vs yesterday' }} />
        <MetricCard label="Entities Below Min" value={String(criticalCount)} icon={AlertTriangle} change={{ value: criticalCount > 0 ? 'Action needed' : 'All healthy', direction: criticalCount > 0 ? 'down' : 'flat' }} />
        <MetricCard label="Inflows (Today)" value="$24.8K" icon={TrendingUp} change={{ value: '3 deposits', direction: 'up' }} />
        <MetricCard label="Outflows (Today)" value="$18.2K" icon={TrendingDown} change={{ value: '8 payments', direction: 'down' }} />
      </div>

      {/* AI Insights */}
      <div className="card">
        <div className="px-5 py-3 border-b border-slate-800 flex items-center gap-2">
          <Sparkles size={14} className="text-brand-500" />
          <h3 className="text-sm font-semibold text-white">AI Cash Intelligence</h3>
        </div>
        <div className="divide-y divide-slate-800/30">
          {AI_INSIGHTS.map((insight, i) => (
            <div key={i} className="px-5 py-3 flex gap-3">
              <div className={clsx(
                'h-1.5 w-1.5 rounded-full mt-1.5 shrink-0',
                insight.type === 'warning' && 'bg-amber-400',
                insight.type === 'info' && 'bg-blue-400',
                insight.type === 'success' && 'bg-emerald-400',
              )} />
              <p className="text-sm text-slate-300">{insight.text}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Per-entity breakdown */}
      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-800">
          <h3 className="text-sm font-semibold text-white">Per-Entity Cash Position</h3>
        </div>
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-800">
              <th className="px-5 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Company</th>
              <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Accounts</th>
              <th className="px-4 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Balance</th>
              <th className="px-4 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Minimum</th>
              <th className="px-4 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Cushion</th>
              <th className="px-4 py-3 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/30">
            {DEMO_CASH.map((row) => {
              const cushion = row.totalCents - row.minimumCents;
              return (
                <tr key={row.code} className="table-row-hover cursor-pointer">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <div className="h-7 w-7 rounded bg-slate-800 flex items-center justify-center text-2xs font-bold text-slate-400">
                        {row.code.slice(0, 2)}
                      </div>
                      <span className="text-sm text-slate-200">{row.company}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {row.accounts.map((acct, i) => (
                      <div key={i} className="flex items-center justify-between text-xs text-slate-400">
                        <span>{acct.name} ·{acct.mask}</span>
                        <span className="font-mono tabular-nums ml-4">{formatMoney(acct.balanceCents)}</span>
                      </div>
                    ))}
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-mono tabular-nums text-white font-medium">
                    {formatMoney(row.totalCents)}
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-mono tabular-nums text-slate-500">
                    {formatMoney(row.minimumCents)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className={clsx(
                      'text-sm font-mono tabular-nums',
                      cushion >= 0 ? 'text-emerald-400' : 'text-red-400',
                    )}>
                      {formatMoney(cushion)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <StatusBadge status={row.status} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
