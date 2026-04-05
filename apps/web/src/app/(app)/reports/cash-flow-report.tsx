'use client';

import { AlertCircle, Loader2, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { useQuery } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';

interface CashFlowItem { label: string; amountCents: number }
interface CashFlowResponse {
  period: { startDate: string; endDate: string };
  operating: { netIncome: number; adjustments: CashFlowItem[]; changesInWorkingCapital: CashFlowItem[]; totalCents: number };
  investing: { items: CashFlowItem[]; totalCents: number };
  financing: { items: CashFlowItem[]; totalCents: number };
  netChangeCents: number;
  beginningCashCents: number;
  endingCashCents: number;
}

function CfLine({ label, amount, indent, bold }: { label: string; amount: number; indent?: boolean; bold?: boolean }) {
  return (
    <tr className="hover:bg-slate-800/20 transition-colors">
      <td className={`px-6 py-1.5 text-sm ${indent ? 'pl-12' : ''} ${bold ? 'font-semibold text-white' : 'text-slate-300'}`}>{label}</td>
      <td className={`px-6 py-1.5 text-right font-mono tabular-nums text-sm ${bold ? 'font-semibold text-white' : amount < 0 ? 'text-red-400' : 'text-slate-300'}`}>
        {amount !== 0 ? formatMoney(amount) : '—'}
      </td>
    </tr>
  );
}

function SectionTotal({ label, amount }: { label: string; amount: number }) {
  const Icon = amount > 0 ? TrendingUp : amount < 0 ? TrendingDown : Minus;
  return (
    <tr className="bg-slate-800/30">
      <td className="px-6 py-2 text-sm font-semibold text-white flex items-center gap-2">
        <Icon size={14} className={amount > 0 ? 'text-emerald-400' : amount < 0 ? 'text-red-400' : 'text-slate-500'} />
        {label}
      </td>
      <td className={`px-6 py-2 text-right font-mono tabular-nums text-sm font-semibold ${amount >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
        {formatMoney(amount)}
      </td>
    </tr>
  );
}

export function CashFlowReport({ startDate, endDate, locationId }: { startDate: string; endDate: string; locationId: string }) {
  const params: Record<string, string> = { start_date: startDate, end_date: endDate };
  if (locationId !== 'all') params.location_id = locationId;

  const { data, isLoading, error } = useQuery<CashFlowResponse>('/api/reports/cash-flow', params);

  if (isLoading) return <div className="card p-12 flex items-center justify-center"><Loader2 size={24} className="animate-spin text-slate-500" /></div>;
  if (error) return <div className="card p-8 text-center"><AlertCircle size={24} className="mx-auto text-red-400 mb-2" /><p className="text-sm text-red-400">{String(error)}</p></div>;
  if (!data) return <div className="card p-8 text-center text-sm text-slate-500">No data available for this period.</div>;

  const { operating, investing, financing } = data;

  return (
    <div className="card overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-800">
        <h2 className="text-base font-semibold text-white">Statement of Cash Flows</h2>
        <p className="text-2xs text-slate-500 mt-0.5 font-mono">{startDate} through {endDate} — Indirect Method</p>
      </div>

      <table className="w-full">
        <thead>
          <tr className="border-b border-slate-800/50">
            <th className="px-6 py-2.5 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Description</th>
            <th className="px-6 py-2.5 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Amount</th>
          </tr>
        </thead>
        <tbody>
          {/* Operating Activities */}
          <tr className="bg-slate-800/40">
            <td colSpan={2} className="px-6 py-2 text-xs font-semibold text-slate-300 uppercase tracking-wider">
              Cash Flows from Operating Activities
            </td>
          </tr>
          <CfLine label="Net Income" amount={operating.netIncome} bold />

          {operating.adjustments.length > 0 && (
            <>
              <tr><td colSpan={2} className="px-6 pt-2 pb-1 text-2xs text-slate-500 uppercase tracking-wider">Adjustments for non-cash items</td></tr>
              {operating.adjustments.map((a) => <CfLine key={a.label} label={a.label} amount={a.amountCents} indent />)}
            </>
          )}

          {operating.changesInWorkingCapital.length > 0 && (
            <>
              <tr><td colSpan={2} className="px-6 pt-2 pb-1 text-2xs text-slate-500 uppercase tracking-wider">Changes in working capital</td></tr>
              {operating.changesInWorkingCapital.map((a) => <CfLine key={a.label} label={a.label} amount={a.amountCents} indent />)}
            </>
          )}
          <SectionTotal label="Net Cash from Operations" amount={operating.totalCents} />

          {/* Investing Activities */}
          <tr className="bg-slate-800/40">
            <td colSpan={2} className="px-6 py-2 text-xs font-semibold text-slate-300 uppercase tracking-wider">
              Cash Flows from Investing Activities
            </td>
          </tr>
          {investing.items.length > 0
            ? investing.items.map((a) => <CfLine key={a.label} label={a.label} amount={a.amountCents} indent />)
            : <CfLine label="No investing activity" amount={0} indent />
          }
          <SectionTotal label="Net Cash from Investing" amount={investing.totalCents} />

          {/* Financing Activities */}
          <tr className="bg-slate-800/40">
            <td colSpan={2} className="px-6 py-2 text-xs font-semibold text-slate-300 uppercase tracking-wider">
              Cash Flows from Financing Activities
            </td>
          </tr>
          {financing.items.length > 0
            ? financing.items.map((a) => <CfLine key={a.label} label={a.label} amount={a.amountCents} indent />)
            : <CfLine label="No financing activity" amount={0} indent />
          }
          <SectionTotal label="Net Cash from Financing" amount={financing.totalCents} />

          {/* Net Change + Beginning/Ending */}
          <tr className="border-t-2 border-slate-700"><td colSpan={2} className="h-1" /></tr>
          <CfLine label="Net Change in Cash" amount={data.netChangeCents} bold />
          <CfLine label="Beginning Cash Balance" amount={data.beginningCashCents} />
          <tr className="bg-emerald-500/[0.04]">
            <td className="px-6 py-3 text-base font-semibold text-white">Ending Cash Balance</td>
            <td className="px-6 py-3 text-right text-lg font-mono tabular-nums font-semibold text-emerald-400">
              {formatMoney(data.endingCashCents)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
