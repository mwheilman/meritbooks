'use client';

import { useState } from 'react';
import { useQuery } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import {
  Loader2, AlertCircle, TrendingUp, TrendingDown, Wallet, AlertTriangle,
  ArrowDownRight, ArrowUpRight, ShieldAlert, ShieldCheck, SlidersHorizontal,
} from 'lucide-react';
import { clsx } from 'clsx';

interface ForecastLineItem { id: string; label: string; party?: string; amountCents: number; category: string; date: string }
interface ForecastWeek {
  index: number; weekNumber: number; startDate: string; endDate: string;
  openingCents: number; collectionsCents: number; disbursementsCents: number;
  netCents: number; closingCents: number;
  byCategory: Record<string, number>;
  collectionItems: ForecastLineItem[]; disbursementItems: ForecastLineItem[];
  belowBuffer: boolean;
}
interface DriverForecastResponse {
  anchorDate: string; horizonWeeks: number;
  openingCashCents: number; endingCashCents: number; minimumBufferCents: number;
  weeks: ForecastWeek[];
  totalCollectionsCents: number; totalDisbursementsCents: number;
  lowWaterMarkCents: number; lowWaterWeekIndex: number;
  shortfallWeekIndexes: number[]; hasShortfall: boolean; firstShortfallWeekIndex: number;
  beyondHorizonCollectionsCents: number; beyondHorizonDisbursementsCents: number;
  drivers: { collectionLagDays: number; paymentLagDays: number; minimumBufferCents: number; horizonWeeks: number; openInvoiceCount: number; openBillCount: number; recurringFlowCount: number; debtServiceCount: number };
}

function Stat({ icon: Icon, label, value, tone }: { icon: typeof Wallet; label: string; value: string; tone?: 'good' | 'bad' | 'warn' }) {
  const cls = tone === 'good' ? 'text-emerald-400' : tone === 'bad' ? 'text-red-400' : tone === 'warn' ? 'text-amber-400' : 'text-white';
  const iconCls = tone === 'good' ? 'text-emerald-400' : tone === 'bad' ? 'text-red-400' : tone === 'warn' ? 'text-amber-400' : 'text-slate-400';
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-1">
        <Icon size={14} className={iconCls} />
        <span className="text-xs text-slate-500 uppercase tracking-wider">{label}</span>
      </div>
      <p className={clsx('text-2xl font-mono font-semibold', cls)}>{value}</p>
    </div>
  );
}

export function CashForecast({ locationId }: { locationId?: string }) {
  const [collectionLag, setCollectionLag] = useState(0);
  const [paymentLag, setPaymentLag] = useState(0);
  const [bufferDollars, setBufferDollars] = useState(0);

  const params: Record<string, string> = {
    collection_lag_days: String(collectionLag),
    payment_lag_days: String(paymentLag),
    minimum_buffer_cents: String(Math.round(bufferDollars * 100)),
  };
  if (locationId) params.location_id = locationId;

  const { data, isLoading, error } = useQuery<DriverForecastResponse>('/api/forecast/cash', params);

  if (isLoading) return <div className="card p-12 flex items-center justify-center"><Loader2 size={24} className="animate-spin text-slate-500" /></div>;
  if (error) return <div className="card p-8 text-center"><AlertCircle size={24} className="mx-auto text-red-400 mb-2" /><p className="text-sm text-red-400">{String(error)}</p></div>;
  if (!data) return <div className="card p-8 text-center text-sm text-slate-500">No forecast data available.</div>;

  const noDrivers = data.drivers.openInvoiceCount === 0 && data.drivers.openBillCount === 0 && data.drivers.recurringFlowCount === 0;

  // Waterfall scaling: max of collections / disbursements across weeks.
  const maxFlow = Math.max(1, ...data.weeks.map((w) => Math.max(w.collectionsCents, w.disbursementsCents)));

  return (
    <div className="space-y-5">
      {/* Header + driver controls */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-base font-semibold text-white flex items-center gap-2">
            <TrendingUp size={16} className="text-emerald-400" /> Driver-Based Cash Forecast
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {data.horizonWeeks}-week projection from open AR, open AP, debt service and recurring obligations · anchored {data.anchorDate}
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap p-3 rounded-xl bg-slate-800/20 border border-slate-800">
          <SlidersHorizontal size={13} className="text-slate-500" />
          <label className="flex items-center gap-1.5 text-xs text-slate-400">
            Collection lag
            <input type="number" min={0} max={120} value={collectionLag} onChange={(e) => setCollectionLag(Math.max(0, Number(e.target.value) || 0))}
              className="w-16 px-2 py-1 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white font-mono" />
            <span className="text-slate-600">days</span>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-slate-400">
            Payment lag
            <input type="number" min={0} max={120} value={paymentLag} onChange={(e) => setPaymentLag(Math.max(0, Number(e.target.value) || 0))}
              className="w-16 px-2 py-1 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white font-mono" />
            <span className="text-slate-600">days</span>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-slate-400">
            Min buffer $
            <input type="number" min={0} step={1000} value={bufferDollars} onChange={(e) => setBufferDollars(Math.max(0, Number(e.target.value) || 0))}
              className="w-24 px-2 py-1 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white font-mono" />
          </label>
        </div>
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat icon={Wallet} label="Opening Cash" value={formatMoney(data.openingCashCents, { compact: true })} />
        <Stat icon={data.endingCashCents >= data.openingCashCents ? TrendingUp : TrendingDown}
          label="Projected Ending" value={formatMoney(data.endingCashCents, { compact: true })}
          tone={data.endingCashCents < data.minimumBufferCents ? 'bad' : 'good'} />
        <Stat icon={data.lowWaterMarkCents < data.minimumBufferCents ? ShieldAlert : ShieldCheck}
          label="Low-Water Mark" value={formatMoney(data.lowWaterMarkCents, { compact: true })}
          tone={data.lowWaterMarkCents < 0 ? 'bad' : data.lowWaterMarkCents < data.minimumBufferCents ? 'warn' : 'good'} />
        <Stat icon={AlertTriangle} label="Shortfall Weeks" value={String(data.shortfallWeekIndexes.length)}
          tone={data.hasShortfall ? 'bad' : 'good'} />
      </div>

      {/* Shortfall banner */}
      {data.hasShortfall && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl border bg-red-500/[0.06] border-red-500/20 text-red-300 text-xs">
          <AlertTriangle size={14} />
          <span>
            Projected cash dips below your {formatMoney(data.minimumBufferCents)} buffer in
            {' '}<span className="font-semibold">week {data.firstShortfallWeekIndex + 1}</span>
            {' '}({data.weeks[data.firstShortfallWeekIndex]?.startDate}). Accelerate collections or defer disbursements.
          </span>
        </div>
      )}

      {noDrivers ? (
        <div className="card p-10 text-center">
          <Wallet className="w-8 h-8 mx-auto text-slate-700 mb-2" />
          <p className="text-sm text-slate-500">No open AR/AP or recurring obligations to project.</p>
          <p className="text-xs text-slate-600 mt-1">Add invoices, bills, or recurring templates to build a forecast.</p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          {/* Collections vs Disbursements waterfall */}
          <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-4 text-xs">
              <span className="flex items-center gap-1.5 text-emerald-400"><ArrowUpRight size={13} /> Collections {formatMoney(data.totalCollectionsCents, { compact: true })}</span>
              <span className="flex items-center gap-1.5 text-red-400"><ArrowDownRight size={13} /> Disbursements {formatMoney(data.totalDisbursementsCents, { compact: true })}</span>
            </div>
            <span className="text-2xs text-slate-500 font-mono">
              {data.drivers.openInvoiceCount} AR · {data.drivers.openBillCount} AP · {data.drivers.recurringFlowCount} recurring
            </span>
          </div>

          <div className="px-6 py-5 flex items-end gap-1.5 overflow-x-auto">
            {data.weeks.map((w) => {
              const upH = Math.round((w.collectionsCents / maxFlow) * 60);
              const downH = Math.round((w.disbursementsCents / maxFlow) * 60);
              return (
                <div key={w.index} className="flex flex-col items-center gap-0.5 min-w-[34px] flex-1 group relative">
                  {/* collections up */}
                  <div className="w-full flex flex-col justify-end" style={{ height: 62 }}>
                    <div className="w-full rounded-t bg-emerald-500/70 group-hover:bg-emerald-400 transition-colors" style={{ height: Math.max(w.collectionsCents > 0 ? 2 : 0, upH) }} />
                  </div>
                  {/* disbursements down */}
                  <div className="w-full flex flex-col justify-start" style={{ height: 62 }}>
                    <div className="w-full rounded-b bg-red-500/70 group-hover:bg-red-400 transition-colors" style={{ height: Math.max(w.disbursementsCents > 0 ? 2 : 0, downH) }} />
                  </div>
                  <span className={clsx('text-[9px] font-mono mt-0.5', w.belowBuffer ? 'text-red-400 font-semibold' : 'text-slate-600')}>{w.weekNumber}</span>
                  {/* tooltip */}
                  <div className="absolute bottom-full mb-1 hidden group-hover:block z-10 w-44 p-2 rounded-lg bg-slate-950 border border-slate-700 shadow-xl text-2xs">
                    <p className="text-slate-400 font-mono mb-1">Wk {w.weekNumber} · {w.startDate}</p>
                    <div className="flex justify-between text-emerald-400"><span>Collections</span><span className="font-mono">{formatMoney(w.collectionsCents)}</span></div>
                    <div className="flex justify-between text-red-400"><span>Disbursements</span><span className="font-mono">{formatMoney(w.disbursementsCents)}</span></div>
                    <div className={clsx('flex justify-between font-semibold border-t border-slate-800 mt-1 pt-1', w.closingCents < data.minimumBufferCents ? 'text-red-400' : 'text-white')}>
                      <span>Closing</span><span className="font-mono">{formatMoney(w.closingCents)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Weekly ledger table */}
          <div className="overflow-x-auto border-t border-slate-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800/50 text-2xs uppercase tracking-wider text-slate-500">
                  <th className="px-6 py-2 text-left">Week</th>
                  <th className="px-4 py-2 text-right">Opening</th>
                  <th className="px-4 py-2 text-right">Collections</th>
                  <th className="px-4 py-2 text-right">Disbursements</th>
                  <th className="px-4 py-2 text-right">Net</th>
                  <th className="px-6 py-2 text-right">Closing</th>
                </tr>
              </thead>
              <tbody>
                {data.weeks.map((w) => (
                  <tr key={w.index} className={clsx('border-b border-slate-800/30 hover:bg-slate-800/20 transition-colors', w.belowBuffer && 'bg-red-500/[0.04]')}>
                    <td className="px-6 py-1.5">
                      <span className="text-slate-300">Week {w.weekNumber}</span>
                      <span className="text-2xs text-slate-600 font-mono ml-2">{w.startDate}</span>
                      {w.belowBuffer && <span className="ml-2 text-[9px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-400">below buffer</span>}
                    </td>
                    <td className="px-4 py-1.5 text-right font-mono tabular-nums text-slate-400">{formatMoney(w.openingCents)}</td>
                    <td className="px-4 py-1.5 text-right font-mono tabular-nums text-emerald-400">{w.collectionsCents ? formatMoney(w.collectionsCents) : '—'}</td>
                    <td className="px-4 py-1.5 text-right font-mono tabular-nums text-red-400">{w.disbursementsCents ? `(${formatMoney(w.disbursementsCents)})` : '—'}</td>
                    <td className={clsx('px-4 py-1.5 text-right font-mono tabular-nums', w.netCents < 0 ? 'text-red-400' : 'text-slate-300')}>{formatMoney(w.netCents)}</td>
                    <td className={clsx('px-6 py-1.5 text-right font-mono tabular-nums font-semibold', w.closingCents < data.minimumBufferCents ? 'text-red-400' : 'text-white')}>{formatMoney(w.closingCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
