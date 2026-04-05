'use client';

import { MetricCard, StatusBadge } from '@/components/ui';
import { Clock, Users, DollarSign, Calculator } from 'lucide-react';
import { formatMoney } from '@meritbooks/shared';

interface ChargebackSummary {
  companyName: string;
  shortCode: string;
  cogsLabor: number;
  opexLabor: number;
  cogsExpenses: number;
  opexExpenses: number;
  sharedCosts: number;
  directAssigned: number;
  total: number;
  invoiceNumber: string;
  status: string;
}

const DEMO_CHARGEBACKS: ChargebackSummary[] = [
  { companyName: 'Swan Creek Construction', shortCode: 'SCC', cogsLabor: 1240000, opexLabor: 320000, cogsExpenses: 480000, opexExpenses: 120000, sharedCosts: 89400, directAssigned: 0, total: 2249400, invoiceNumber: 'CB-2026-0315-SCC', status: 'APPROVED' },
  { companyName: 'Iowa Custom Cabinetry', shortCode: 'ICC', cogsLabor: 980000, opexLabor: 240000, cogsExpenses: 320000, opexExpenses: 80000, sharedCosts: 89400, directAssigned: 0, total: 1709400, invoiceNumber: 'CB-2026-0315-ICC', status: 'APPROVED' },
  { companyName: 'Heartland HVAC', shortCode: 'HH', cogsLabor: 860000, opexLabor: 180000, cogsExpenses: 240000, opexExpenses: 60000, sharedCosts: 89400, directAssigned: 0, total: 1429400, invoiceNumber: 'CB-2026-0315-HH', status: 'DRAFT' },
  { companyName: 'Dorrian Mechanical', shortCode: 'DM', cogsLabor: 620000, opexLabor: 160000, cogsExpenses: 180000, opexExpenses: 40000, sharedCosts: 89400, directAssigned: 0, total: 1089400, invoiceNumber: 'CB-2026-0315-DM', status: 'DRAFT' },
  { companyName: 'Central Iowa Restoration', shortCode: 'CIR', cogsLabor: 440000, opexLabor: 120000, cogsExpenses: 160000, opexExpenses: 40000, sharedCosts: 89400, directAssigned: 0, total: 849400, invoiceNumber: 'CB-2026-0315-CIR', status: 'POSTED' },
  { companyName: 'Artistry Interiors', shortCode: 'AIN', cogsLabor: 380000, opexLabor: 100000, cogsExpenses: 120000, opexExpenses: 30000, sharedCosts: 89400, directAssigned: 0, total: 719400, invoiceNumber: 'CB-2026-0315-AIN', status: 'DRAFT' },
];

export function ChargebackDashboard() {
  const totalBilled = DEMO_CHARGEBACKS.reduce((s, c) => s + c.total, 0);

  return (
    <div>
      {/* OH Rate summary */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <MetricCard
          label="Current OH Rate"
          value="$5.04/hr"
          icon={Calculator}
          change={{ value: 'March 2026', direction: 'flat' }}
        />
        <MetricCard
          label="Shared Pool"
          value="$9,072"
          icon={DollarSign}
          change={{ value: '$48.2K total - exclusions', direction: 'flat' }}
        />
        <MetricCard
          label="Billing Capacity"
          value="1,800 hrs"
          icon={Clock}
          change={{ value: '12 production × 150 hrs', direction: 'flat' }}
        />
        <MetricCard
          label="Total Billed"
          value={formatMoney(totalBilled, { compact: true })}
          icon={Users}
          change={{ value: `${DEMO_CHARGEBACKS.length} companies`, direction: 'flat' }}
        />
      </div>

      {/* OH rate formula */}
      <div className="card p-5 mb-6">
        <h3 className="text-sm font-semibold text-white mb-3">March 2026 Overhead Calculation</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div className="space-y-1.5">
            <div className="flex justify-between text-slate-400">
              <span>Total Merit OpEx (6000-series)</span>
              <span className="font-mono tabular-nums">$48,200</span>
            </div>
            <div className="flex justify-between text-red-400">
              <span>− 10% × Owner Group (Mike + Ryan)</span>
              <span className="font-mono tabular-nums">($3,680)</span>
            </div>
            <div className="flex justify-between text-red-400">
              <span>− 100% × Deal Team</span>
              <span className="font-mono tabular-nums">($12,400)</span>
            </div>
            <div className="flex justify-between text-red-400">
              <span>− 100% × Direct Assigned</span>
              <span className="font-mono tabular-nums">($23,048)</span>
            </div>
            <div className="flex justify-between text-white font-medium border-t border-slate-700 pt-1.5">
              <span>= Shared OpEx Pool</span>
              <span className="font-mono tabular-nums">$9,072</span>
            </div>
          </div>
          <div className="space-y-1.5">
            <div className="flex justify-between text-slate-400">
              <span>Production Employees</span>
              <span className="font-mono tabular-nums">12</span>
            </div>
            <div className="flex justify-between text-slate-400">
              <span>× Hours per employee</span>
              <span className="font-mono tabular-nums">150</span>
            </div>
            <div className="flex justify-between text-white font-medium border-t border-slate-700 pt-1.5">
              <span>= Billing Capacity</span>
              <span className="font-mono tabular-nums">1,800 hrs</span>
            </div>
            <div className="flex justify-between text-brand-400 font-semibold mt-2">
              <span>OH Rate = Pool ÷ Capacity</span>
              <span className="font-mono tabular-nums">$5.04/hr</span>
            </div>
          </div>
        </div>
      </div>

      {/* Invoice grid */}
      <div className="card overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-800">
          <h3 className="text-sm font-semibold text-white">March 2026 Chargeback Invoices</h3>
        </div>
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-800">
              <th className="px-5 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Company</th>
              <th className="px-4 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">COGS Labor</th>
              <th className="px-4 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">OpEx Labor</th>
              <th className="px-4 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">COGS Exp</th>
              <th className="px-4 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">OpEx Exp</th>
              <th className="px-4 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Shared</th>
              <th className="px-4 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500 font-bold">Total</th>
              <th className="px-4 py-3 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/30">
            {DEMO_CHARGEBACKS.map((cb) => (
              <tr key={cb.shortCode} className="table-row-hover cursor-pointer">
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2">
                    <div className="h-6 w-6 rounded bg-slate-800 flex items-center justify-center text-2xs font-bold text-slate-400">
                      {cb.shortCode.slice(0, 2)}
                    </div>
                    <div>
                      <p className="text-sm text-slate-200">{cb.companyName}</p>
                      <p className="text-2xs text-slate-500 font-mono">{cb.invoiceNumber}</p>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-right text-sm font-mono tabular-nums text-slate-300">{formatMoney(cb.cogsLabor)}</td>
                <td className="px-4 py-3 text-right text-sm font-mono tabular-nums text-slate-400">{formatMoney(cb.opexLabor)}</td>
                <td className="px-4 py-3 text-right text-sm font-mono tabular-nums text-slate-300">{formatMoney(cb.cogsExpenses)}</td>
                <td className="px-4 py-3 text-right text-sm font-mono tabular-nums text-slate-400">{formatMoney(cb.opexExpenses)}</td>
                <td className="px-4 py-3 text-right text-sm font-mono tabular-nums text-slate-400">{formatMoney(cb.sharedCosts)}</td>
                <td className="px-4 py-3 text-right text-sm font-mono tabular-nums text-white font-medium">{formatMoney(cb.total)}</td>
                <td className="px-4 py-3 text-center"><StatusBadge status={cb.status} /></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-700 bg-slate-800/20">
              <td className="px-5 py-3 text-sm font-bold text-white">Total</td>
              <td className="px-4 py-3 text-right text-sm font-mono tabular-nums font-bold text-white">{formatMoney(DEMO_CHARGEBACKS.reduce((s, c) => s + c.cogsLabor, 0))}</td>
              <td className="px-4 py-3 text-right text-sm font-mono tabular-nums font-bold text-slate-300">{formatMoney(DEMO_CHARGEBACKS.reduce((s, c) => s + c.opexLabor, 0))}</td>
              <td className="px-4 py-3 text-right text-sm font-mono tabular-nums font-bold text-white">{formatMoney(DEMO_CHARGEBACKS.reduce((s, c) => s + c.cogsExpenses, 0))}</td>
              <td className="px-4 py-3 text-right text-sm font-mono tabular-nums font-bold text-slate-300">{formatMoney(DEMO_CHARGEBACKS.reduce((s, c) => s + c.opexExpenses, 0))}</td>
              <td className="px-4 py-3 text-right text-sm font-mono tabular-nums font-bold text-slate-300">{formatMoney(DEMO_CHARGEBACKS.reduce((s, c) => s + c.sharedCosts, 0))}</td>
              <td className="px-4 py-3 text-right text-sm font-mono tabular-nums font-bold text-brand-400">{formatMoney(totalBilled)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
