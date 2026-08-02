'use client';

import { AlertCircle, Loader2, TrendingUp, TrendingDown, Minus, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useQuery } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';

interface DirectLine { key: string; label: string; section: string; amountCents: number }
interface SectionResult { lines: DirectLine[]; totalCents: number }
interface DirectCashFlowResponse {
  period: { startDate: string; endDate: string };
  method: 'direct';
  operating: SectionResult;
  investing: SectionResult;
  financing: SectionResult;
  netChangeCents: number;
  beginningCashCents: number;
  endingCashCents: number;
  varianceCents: number;
  reconciled: boolean;
  meta: { entryCount: number; cashMovingEntryCount: number; consolidated: boolean };
}

function CfLine({ label, amount, indent }: { label: string; amount: number; indent?: boolean }) {
  return (
    <tr className="hover:bg-slate-800/20 transition-colors">
      <td className={`px-6 py-1.5 text-sm text-slate-300 ${indent ? 'pl-12' : ''}`}>{label}</td>
      <td className={`px-6 py-1.5 text-right font-mono tabular-nums text-sm ${amount < 0 ? 'text-red-400' : 'text-slate-300'}`}>
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

function Section({ title, section, emptyLabel }: { title: string; section: SectionResult; emptyLabel: string }) {
  return (
    <>
      <tr className="bg-slate-800/40">
        <td colSpan={2} className="px-6 py-2 text-xs font-semibold text-slate-300 uppercase tracking-wider">{title}</td>
      </tr>
      {section.lines.length > 0
        ? section.lines.map((l) => <CfLine key={l.key} label={l.label} amount={l.amountCents} indent />)
        : <CfLine label={emptyLabel} amount={0} indent />}
      <SectionTotal label={`Net Cash from ${title.replace('Cash Flows from ', '')}`} amount={section.totalCents} />
    </>
  );
}

export function CashFlowDirectReport({ startDate, endDate, locIds }: { startDate: string; endDate: string; locIds: string }) {
  const params: Record<string, string> = { start_date: startDate, end_date: endDate };
  if (locIds) params.location_ids = locIds;

  const { data, isLoading, error } = useQuery<DirectCashFlowResponse>('/api/reports/cash-flow-direct', params);

  if (isLoading) return <div className="card p-12 flex items-center justify-center"><Loader2 size={24} className="animate-spin text-slate-500" /></div>;
  if (error) return <div className="card p-8 text-center"><AlertCircle size={24} className="mx-auto text-red-400 mb-2" /><p className="text-sm text-red-400">{String(error)}</p></div>;
  if (!data) return <div className="card p-8 text-center text-sm text-slate-500">No data available for this period.</div>;

  const noActivity = data.meta.cashMovingEntryCount === 0;

  return (
    <div className="space-y-4">
      {/* Reconciliation banner — the direct method must tie to the cash movement. */}
      <div className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border text-xs ${
        data.reconciled
          ? 'bg-emerald-500/[0.06] border-emerald-500/20 text-emerald-300'
          : 'bg-amber-500/[0.06] border-amber-500/20 text-amber-300'
      }`}>
        {data.reconciled ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
        {data.reconciled ? (
          <span>Ties out — direct-method total equals the change in cash across {data.meta.cashMovingEntryCount.toLocaleString()} cash entries.</span>
        ) : (
          <span>Out of balance by <span className="font-mono">{formatMoney(data.varianceCents)}</span> — some cash movement could not be classified. Review unusual entries.</span>
        )}
      </div>

      <div className="card overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-800">
          <h2 className="text-base font-semibold text-white">Statement of Cash Flows</h2>
          <p className="text-2xs text-slate-500 mt-0.5 font-mono">{startDate} through {endDate} — Direct Method</p>
        </div>

        {noActivity ? (
          <div className="p-10 text-center text-sm text-slate-500">No cash-moving activity posted in this period.</div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-800/50">
                <th className="px-6 py-2.5 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Description</th>
                <th className="px-6 py-2.5 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Amount</th>
              </tr>
            </thead>
            <tbody>
              <Section title="Cash Flows from Operating Activities" section={data.operating} emptyLabel="No operating activity" />
              <Section title="Cash Flows from Investing Activities" section={data.investing} emptyLabel="No investing activity" />
              <Section title="Cash Flows from Financing Activities" section={data.financing} emptyLabel="No financing activity" />

              <tr className="border-t-2 border-slate-700"><td colSpan={2} className="h-1" /></tr>
              <tr className="hover:bg-slate-800/20">
                <td className="px-6 py-1.5 text-sm font-semibold text-white">Net Change in Cash</td>
                <td className={`px-6 py-1.5 text-right font-mono tabular-nums text-sm font-semibold ${data.netChangeCents < 0 ? 'text-red-400' : 'text-white'}`}>{formatMoney(data.netChangeCents)}</td>
              </tr>
              <CfLine label="Beginning Cash Balance" amount={data.beginningCashCents} />
              <tr className="bg-emerald-500/[0.04]">
                <td className="px-6 py-3 text-base font-semibold text-white">Ending Cash Balance</td>
                <td className="px-6 py-3 text-right text-lg font-mono tabular-nums font-semibold text-emerald-400">{formatMoney(data.endingCashCents)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
