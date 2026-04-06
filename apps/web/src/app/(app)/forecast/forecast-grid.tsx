'use client';

import { useMemo } from 'react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { useQuery } from '@/hooks';
import { Loader2, AlertCircle, TrendingUp, Calendar } from 'lucide-react';

interface CashSummary {
  totalCashCents: number;
  entityCount: number;
}

interface CashResponse {
  locations: unknown[];
  summary: CashSummary;
}

interface WeekData {
  weekLabel: string;
  startDate: string;
  openingCents: number;
  inflowsCents: number;
  outflowsCents: number;
  netCents: number;
  closingCents: number;
  confidence: number;
}

function buildForecastWeeks(startingCashCents: number): WeekData[] {
  // Build 13 empty weeks starting from next Monday
  const weeks: WeekData[] = [];
  const today = new Date();
  const dayOfWeek = today.getDay();
  const nextMonday = new Date(today);
  nextMonday.setDate(today.getDate() + ((8 - dayOfWeek) % 7 || 7));

  let balance = startingCashCents;

  for (let i = 0; i < 13; i++) {
    const weekStart = new Date(nextMonday);
    weekStart.setDate(nextMonday.getDate() + i * 7);
    const dateStr = weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    // Confidence degrades over time per spec: 92% weeks 1-2, 78% weeks 3-6, 64% weeks 7-13
    const confidence = i < 2 ? 92 : i < 6 ? 78 : 64;

    weeks.push({
      weekLabel: `W${i + 1}`,
      startDate: dateStr,
      openingCents: balance,
      inflowsCents: 0,
      outflowsCents: 0,
      netCents: 0,
      closingCents: balance,
      confidence,
    });
  }

  return weeks;
}

export function ForecastGrid() {
  const { data: cashData, isLoading, error } = useQuery<CashResponse>('/api/cash');

  const startingCash = cashData?.summary?.totalCashCents ?? 0;
  const weeks = useMemo(() => buildForecastWeeks(startingCash), [startingCash]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 text-emerald-400 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 text-center">
        <AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" />
        <p className="text-sm text-red-400">{error}</p>
      </div>
    );
  }

  const hasData = startingCash > 0;

  return (
    <div className="space-y-4">
      {/* Info banner when no real forecast data */}
      {!hasData && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-lg bg-indigo-500/5 border border-indigo-500/10">
          <TrendingUp size={16} className="text-indigo-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm text-indigo-300">Forecast will populate as data flows in</p>
            <p className="text-xs text-slate-500 mt-0.5">
              Connect bank accounts, enter AP bills, and create AR invoices. The 13-week forecast
              synthesizes bank feeds, AP/AR aging, payroll schedules, and recurring transactions
              to project weekly cash positions.
            </p>
          </div>
        </div>
      )}

      {hasData && (
        <div className="flex items-center gap-4 text-xs text-slate-500">
          <span>Starting cash: <span className="font-mono text-white">{formatMoney(startingCash)}</span></span>
          <span className="text-slate-700">·</span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-emerald-500" /> 92% confidence (W1-2)
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-amber-500" /> 78% (W3-6)
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-orange-500" /> 64% (W7-13)
          </span>
        </div>
      )}

      {/* Forecast table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500 sticky left-0 bg-slate-950 z-10 min-w-[140px]">Category</th>
                {weeks.map((w) => (
                  <th key={w.weekLabel} className="px-3 py-2.5 text-center min-w-[100px]">
                    <p className="text-2xs font-semibold uppercase text-slate-500">{w.weekLabel}</p>
                    <p className="text-[10px] text-slate-600 font-mono">{w.startDate}</p>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* Opening Balance */}
              <tr className="bg-slate-800/20">
                <td className="px-4 py-2 text-xs font-medium text-slate-300 sticky left-0 bg-slate-800/20 z-10">Opening Balance</td>
                {weeks.map((w) => (
                  <td key={w.weekLabel} className="px-3 py-2 text-center text-xs font-mono text-slate-400">
                    {formatMoney(w.openingCents)}
                  </td>
                ))}
              </tr>

              {/* Inflows */}
              <tr className="hover:bg-slate-800/10">
                <td className="px-4 py-2 text-xs text-emerald-400 sticky left-0 bg-slate-950 z-10 pl-6">Inflows</td>
                {weeks.map((w) => (
                  <td key={w.weekLabel} className={clsx('px-3 py-2 text-center text-xs font-mono', w.inflowsCents > 0 ? 'text-emerald-400' : 'text-slate-700')}>
                    {w.inflowsCents > 0 ? formatMoney(w.inflowsCents) : '—'}
                  </td>
                ))}
              </tr>

              {/* Outflows */}
              <tr className="hover:bg-slate-800/10">
                <td className="px-4 py-2 text-xs text-red-400 sticky left-0 bg-slate-950 z-10 pl-6">Outflows</td>
                {weeks.map((w) => (
                  <td key={w.weekLabel} className={clsx('px-3 py-2 text-center text-xs font-mono', w.outflowsCents > 0 ? 'text-red-400' : 'text-slate-700')}>
                    {w.outflowsCents > 0 ? `(${formatMoney(w.outflowsCents)})` : '—'}
                  </td>
                ))}
              </tr>

              {/* Net */}
              <tr className="border-t border-slate-800/50 hover:bg-slate-800/10">
                <td className="px-4 py-2 text-xs font-medium text-slate-300 sticky left-0 bg-slate-950 z-10 pl-6">Net Cash Flow</td>
                {weeks.map((w) => (
                  <td key={w.weekLabel} className={clsx('px-3 py-2 text-center text-xs font-mono font-medium', w.netCents > 0 ? 'text-emerald-400' : w.netCents < 0 ? 'text-red-400' : 'text-slate-700')}>
                    {w.netCents !== 0 ? formatMoney(w.netCents) : '—'}
                  </td>
                ))}
              </tr>

              {/* Closing */}
              <tr className="bg-slate-800/20 border-t border-slate-700">
                <td className="px-4 py-2.5 text-xs font-semibold text-white sticky left-0 bg-slate-800/20 z-10">Closing Balance</td>
                {weeks.map((w) => (
                  <td key={w.weekLabel} className={clsx('px-3 py-2.5 text-center text-xs font-mono font-semibold', w.closingCents < 0 ? 'text-red-400 bg-red-500/5' : 'text-white')}>
                    {formatMoney(w.closingCents)}
                  </td>
                ))}
              </tr>

              {/* Confidence */}
              <tr>
                <td className="px-4 py-2 text-[10px] text-slate-600 sticky left-0 bg-slate-950 z-10">Confidence</td>
                {weeks.map((w) => (
                  <td key={w.weekLabel} className="px-3 py-2 text-center">
                    <span className={clsx(
                      'text-[10px] font-mono',
                      w.confidence >= 90 ? 'text-emerald-500' : w.confidence >= 75 ? 'text-amber-500' : 'text-orange-500'
                    )}>
                      {w.confidence}%
                    </span>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
