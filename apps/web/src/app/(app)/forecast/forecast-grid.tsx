'use client';

import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { Sparkles, TrendingUp } from 'lucide-react';

interface WeekData {
  weekLabel: string;
  startDate: string;
  openingCents: number;
  inflowsCents: number;
  outflowsCents: number;
  netCents: number;
  closingCents: number;
  isActual: boolean;
}

// Generate 13 weeks of demo data
function generateWeeks(): WeekData[] {
  const weeks: WeekData[] = [];
  let balance = 23480000; // starting cash
  const baseDate = new Date('2026-04-06');

  for (let i = 0; i < 13; i++) {
    const weekStart = new Date(baseDate);
    weekStart.setDate(baseDate.getDate() + i * 7);
    const label = `W${i + 1}`;
    const dateStr = weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    // Simulate realistic cash flow
    const inflows = Math.round(1800000 + Math.random() * 1200000 + (i < 3 ? 500000 : 0));
    const outflows = Math.round(1600000 + Math.random() * 800000 + (i % 2 === 0 ? 1200000 : 0)); // payroll bi-weekly
    const net = inflows - outflows;

    weeks.push({
      weekLabel: label,
      startDate: dateStr,
      openingCents: balance,
      inflowsCents: inflows,
      outflowsCents: outflows,
      netCents: net,
      closingCents: balance + net,
      isActual: i === 0, // only first week has actuals
    });

    balance = balance + net;
  }
  return weeks;
}

const DEMO_WEEKS = generateWeeks();

const ROWS = [
  { key: 'opening', label: 'Opening Balance', field: 'openingCents' as const, bold: true },
  { key: 'inflows', label: 'Total Inflows', field: 'inflowsCents' as const, bold: false },
  { key: 'outflows', label: 'Total Outflows', field: 'outflowsCents' as const, bold: false },
  { key: 'net', label: 'Net Cash Flow', field: 'netCents' as const, bold: true },
  { key: 'closing', label: 'Closing Balance', field: 'closingCents' as const, bold: true },
];

export function ForecastGrid() {
  return (
    <div className="space-y-4">
      {/* Accuracy badge */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 text-sm">
          <TrendingUp size={14} className="text-emerald-400" />
          <span className="text-slate-400">Forecast accuracy (4-week rolling):</span>
          <span className="text-emerald-400 font-medium font-mono">99.2%</span>
        </div>
        <div className="flex items-center gap-1.5 ml-auto text-2xs text-slate-500">
          <div className="h-2 w-6 rounded bg-brand-500/40" />
          <span>Actual</span>
          <div className="h-2 w-6 rounded bg-slate-700 ml-2" />
          <span>Forecast</span>
        </div>
      </div>

      {/* Forecast table */}
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[1200px]">
          <thead>
            <tr className="border-b border-slate-800">
              <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500 w-40 sticky left-0 bg-surface-900 z-10">
                Cash Flow
              </th>
              {DEMO_WEEKS.map((w) => (
                <th
                  key={w.weekLabel}
                  className={clsx(
                    'px-3 py-3 text-center text-2xs font-semibold uppercase tracking-wider min-w-[90px]',
                    w.isActual ? 'text-brand-400' : 'text-slate-500',
                  )}
                >
                  <div>{w.weekLabel}</div>
                  <div className="font-normal normal-case text-slate-600">{w.startDate}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr
                key={row.key}
                className={clsx(
                  'border-b border-slate-800/30',
                  row.key === 'closing' && 'bg-slate-800/10 border-t border-slate-700',
                  row.key === 'net' && 'border-t border-slate-800/50',
                )}
              >
                <td className={clsx(
                  'px-4 py-2.5 text-sm sticky left-0 bg-surface-900 z-10',
                  row.bold ? 'font-medium text-white' : 'text-slate-400',
                )}>
                  {row.label}
                </td>
                {DEMO_WEEKS.map((w) => {
                  const value = w[row.field];
                  const isNegative = value < 0;
                  return (
                    <td
                      key={w.weekLabel}
                      className={clsx(
                        'px-3 py-2.5 text-right text-xs font-mono tabular-nums',
                        row.bold ? 'font-medium' : '',
                        row.key === 'closing' ? 'text-white font-semibold' : '',
                        row.key === 'net' && isNegative ? 'text-red-400' : '',
                        row.key === 'net' && !isNegative ? 'text-emerald-400' : '',
                        row.key === 'outflows' ? 'text-slate-500' : '',
                        row.key === 'inflows' ? 'text-slate-300' : '',
                        row.key === 'opening' ? 'text-slate-400' : '',
                        w.isActual && 'bg-brand-500/[0.03]',
                      )}
                    >
                      {row.key === 'outflows'
                        ? `(${formatMoney(value)})`
                        : formatMoney(value)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* AI insights */}
      <div className="card">
        <div className="px-5 py-3 border-b border-slate-800 flex items-center gap-2">
          <Sparkles size={14} className="text-brand-500" />
          <h3 className="text-sm font-semibold text-white">Forecast Intelligence</h3>
        </div>
        <div className="p-5 space-y-3">
          <Insight type="risk" text="Week 4 shows converging obligations: Q1 estimated taxes ($28K) + biweekly payroll ($48K) + Carrier HVAC payment ($8.2K). Ensure $85K available by Apr 28." />
          <Insight type="pattern" text="Smith (Kitchen Remodel) pays within 5 days on last 3 draws. Williams averages 12 days late. Forecast adjusts per-customer payment timing." />
          <Insight type="seasonal" text="Materials spend historically rises 22% in March-April (spring construction season). Current week tracking 18% above winter baseline." />
          <Insight type="learning" text="AI is learning that Artistry subs invoice erratically and has widened the confidence band for sub payments ±$4K." />
        </div>
      </div>
    </div>
  );
}

function Insight({ type, text }: { type: string; text: string }) {
  const colors: Record<string, string> = {
    risk: 'bg-red-400',
    pattern: 'bg-blue-400',
    seasonal: 'bg-amber-400',
    learning: 'bg-purple-400',
  };

  return (
    <div className="flex gap-3">
      <div className={clsx('h-1.5 w-1.5 rounded-full mt-1.5 shrink-0', colors[type] ?? 'bg-slate-400')} />
      <p className="text-sm text-slate-300">{text}</p>
    </div>
  );
}
