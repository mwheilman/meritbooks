'use client';

import { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { Loader2, AlertCircle, Calendar, TrendingUp, TrendingDown } from 'lucide-react';
import { useQuery } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';

const PNL_TYPES = ['REVENUE', 'COGS', 'OPEX', 'OTHER'];
const TYPE_LABEL: Record<string, string> = {
  REVENUE: 'Revenue', COGS: 'Cost of Goods Sold', OPEX: 'Operating Expenses', OTHER: 'Other Income / Expense',
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface VarianceRow {
  accountId: string; accountNumber: string; accountName: string; accountType: string;
  budgetCents: number; actualCents: number; varianceCents: number; variancePct: number; isFavorable: boolean;
}
interface VarianceResp {
  period: { fiscalYear: number; periodNumber: number | null; startDate: string; endDate: string };
  data: VarianceRow[];
  totals: Record<string, { budget: number; actual: number; variance: number }>;
}

export function BudgetVsActual({ locationId, fiscalYear, departmentId }: {
  locationId: string; fiscalYear: number; departmentId: string | null;
}) {
  const [period, setPeriod] = useState<number>(0); // 0 = full year, 1..12 = month

  const params = useMemo(() => {
    const p: Record<string, string> = { fiscal_year: String(fiscalYear) };
    if (locationId) p.location_id = locationId;
    if (departmentId) p.department_id = departmentId;
    if (period >= 1) p.period_number = String(period);
    return p;
  }, [fiscalYear, locationId, departmentId, period]);

  const { data, isLoading, error } = useQuery<VarianceResp>('/api/budgets/vs-actual', params);

  const sections = useMemo(() => {
    const rows = data?.data ?? [];
    const map = new Map<string, VarianceRow[]>();
    for (const r of rows) {
      if (!map.has(r.accountType)) map.set(r.accountType, []);
      map.get(r.accountType)!.push(r);
    }
    return PNL_TYPES.filter((t) => map.has(t)).map((t) => ({
      type: t,
      rows: map.get(t)!.sort((a, b) => a.accountNumber.localeCompare(b.accountNumber)),
      totals: data?.totals?.[t] ?? { budget: 0, actual: 0, variance: 0 },
    }));
  }, [data]);

  // Net income = Revenue − COGS − OPEX + Other (Other carries its own sign).
  const net = useMemo(() => {
    const t = data?.totals ?? {};
    const g = (k: string) => t[k] ?? { budget: 0, actual: 0, variance: 0 };
    const budget = g('REVENUE').budget - g('COGS').budget - g('OPEX').budget + g('OTHER').budget;
    const actual = g('REVENUE').actual - g('COGS').actual - g('OPEX').actual + g('OTHER').actual;
    return { budget, actual, variance: budget - actual, favorable: actual >= budget };
  }, [data]);

  return (
    <div>
      {/* Period selector */}
      <div className="flex items-center gap-1.5 mb-4">
        <Calendar size={13} className="text-slate-500" />
        <select
          value={period}
          onChange={(e) => setPeriod(parseInt(e.target.value, 10))}
          className="px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-white"
        >
          <option value={0}>Full Year (FY {fiscalYear})</option>
          {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m} {fiscalYear} (P{i + 1})</option>)}
        </select>
      </div>

      {isLoading ? (
        <div className="card p-12 flex items-center justify-center"><Loader2 size={24} className="animate-spin text-slate-500" /></div>
      ) : error ? (
        <div className="card p-8 text-center"><AlertCircle size={24} className="mx-auto text-red-400 mb-2" /><p className="text-sm text-red-400">{error}</p></div>
      ) : sections.length === 0 ? (
        <div className="card p-10 text-center text-sm text-slate-500">
          No budget or actuals for this scope. Enter a budget in the Budget Entry tab, then post GL activity.
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="px-6 py-3 border-b border-slate-800 flex items-center justify-between">
            <p className="text-2xs text-slate-500 font-mono">
              {data?.period.startDate} → {data?.period.endDate} · budget vs posted actuals
            </p>
            <span className="text-2xs text-slate-500">Favorable in emerald, unfavorable in red</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800/50 text-2xs font-semibold uppercase text-slate-500">
                  <th className="px-4 py-2.5 text-left w-20">Acct</th>
                  <th className="px-4 py-2.5 text-left">Description</th>
                  <th className="px-4 py-2.5 text-right">Budget</th>
                  <th className="px-4 py-2.5 text-right">Actual</th>
                  <th className="px-4 py-2.5 text-right">Variance</th>
                  <th className="px-3 py-2.5 text-right w-20">Var %</th>
                </tr>
              </thead>
              <tbody>
                {sections.map((sec) => (
                  <Section key={sec.type} label={TYPE_LABEL[sec.type] ?? sec.type} rows={sec.rows} totals={sec.totals} />
                ))}
                {/* Net income summary */}
                <tr className="bg-brand-500/[0.04] border-t-2 border-slate-700">
                  <td />
                  <td className="px-4 py-3 text-sm font-semibold text-white">Net Income</td>
                  <td className="px-4 py-3 text-right font-mono font-semibold text-slate-200">{formatMoney(net.budget)}</td>
                  <td className={clsx('px-4 py-3 text-right font-mono font-semibold', net.actual >= 0 ? 'text-white' : 'text-red-400')}>{formatMoney(net.actual)}</td>
                  <td className={clsx('px-4 py-3 text-right font-mono font-semibold flex items-center justify-end gap-1', net.favorable ? 'text-emerald-400' : 'text-red-400')}>
                    {net.favorable ? <TrendingUp size={12} /> : <TrendingDown size={12} />}{formatMoney(Math.abs(net.variance))}
                  </td>
                  <td className="px-3 py-3 text-right font-mono text-2xs text-slate-500">
                    {net.budget !== 0 ? `${Math.round((net.variance / Math.abs(net.budget)) * 1000) / 10}%` : '—'}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ label, rows, totals }: {
  label: string; rows: VarianceRow[]; totals: { budget: number; actual: number; variance: number };
}) {
  return (
    <>
      <tr className="bg-slate-800/30">
        <td colSpan={2} className="px-4 py-2 text-xs font-semibold text-slate-300 uppercase">{label}</td>
        <td className="px-4 py-2 text-right font-mono text-xs font-semibold text-slate-300">{formatMoney(totals.budget)}</td>
        <td className="px-4 py-2 text-right font-mono text-xs font-semibold text-slate-300">{formatMoney(totals.actual)}</td>
        <td className="px-4 py-2 text-right font-mono text-xs font-semibold text-slate-300">{formatMoney(totals.variance)}</td>
        <td />
      </tr>
      {rows.map((r) => (
        <tr key={r.accountId || r.accountNumber} className="hover:bg-slate-800/20">
          <td className="px-4 py-1.5 text-xs font-mono text-slate-500">{r.accountNumber}</td>
          <td className="px-4 py-1.5 text-slate-300">{r.accountName}</td>
          <td className="px-4 py-1.5 text-right font-mono text-slate-300">{formatMoney(r.budgetCents)}</td>
          <td className="px-4 py-1.5 text-right font-mono text-slate-300">{formatMoney(r.actualCents)}</td>
          <td className={clsx('px-4 py-1.5 text-right font-mono font-medium', r.varianceCents === 0 ? 'text-slate-500' : r.isFavorable ? 'text-emerald-400' : 'text-red-400')}>
            {formatMoney(r.varianceCents)}
          </td>
          <td className={clsx('px-3 py-1.5 text-right font-mono text-2xs', r.varianceCents === 0 ? 'text-slate-600' : r.isFavorable ? 'text-emerald-400/80' : 'text-red-400/80')}>
            {r.budgetCents !== 0 ? `${r.variancePct}%` : '—'}
          </td>
        </tr>
      ))}
    </>
  );
}
