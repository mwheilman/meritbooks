'use client';

import { useQuery } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import { Loader2, TrendingUp, TrendingDown, Minus, Activity } from 'lucide-react';
import { clsx } from 'clsx';

interface TrendPoint { date: string; closingCents: number }
interface TrendResponse {
  points: TrendPoint[];
  startCents: number;
  endCents: number;
  changeCents: number;
  changePct: number | null;
  minCents: number;
  maxCents: number;
  asOfDate: string | null;
  hasFeed: boolean;
  accountCount: number;
}

function fmtShortDate(iso: string): string {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * A simple weekly cash-balance trend (reconstructed deterministically from the
 * live balance + the transaction feed). Shows the direction of travel over ~13
 * weeks so a treasurer sees whether cash is building or draining. Degrades to a
 * calm empty state when there's no feed history yet.
 */
export function CashTrend({ locationId }: { locationId?: string }) {
  const params = locationId ? { location_id: locationId } : undefined;
  const { data, isLoading, error } = useQuery<TrendResponse>('/api/cash/trend', params);

  if (isLoading) {
    return (
      <div className="card p-6 flex items-center justify-center h-[168px]">
        <Loader2 className="w-5 h-5 text-emerald-400 animate-spin" />
      </div>
    );
  }
  if (error) {
    return <div className="card p-6 text-center text-xs text-red-400 h-[168px] flex items-center justify-center">{error}</div>;
  }

  const points = data?.points ?? [];
  const min = data?.minCents ?? 0;
  const max = data?.maxCents ?? 0;
  const change = data?.changeCents ?? 0;
  const up = change > 0;
  const flat = change === 0;

  // Build the sparkline path. Guard against a zero range (flat line).
  const W = 100;
  const H = 40;
  const range = Math.max(1, max - min);
  const coords = points.map((p, i) => {
    const x = points.length > 1 ? (i / (points.length - 1)) * W : W / 2;
    const y = H - ((p.closingCents - min) / range) * H;
    return { x, y };
  });
  const linePath = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(2)} ${c.y.toFixed(2)}`).join(' ');
  const areaPath = coords.length
    ? `${linePath} L ${W} ${H} L 0 ${H} Z`
    : '';

  const strokeCls = flat ? 'stroke-slate-500' : up ? 'stroke-emerald-400' : 'stroke-red-400';
  const fillId = up ? 'trendFillUp' : 'trendFillDown';

  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-white flex items-center gap-1.5">
            <Activity size={14} className="text-emerald-400" /> Balance Trend
          </h3>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Weekly cash over ~13 weeks
            {data?.asOfDate && <> · as of {fmtShortDate(data.asOfDate.slice(0, 10))}</>}
          </p>
        </div>
        <div className="text-right">
          <p className="text-lg font-mono font-semibold text-white">{formatMoney(data?.endCents ?? 0, { compact: true })}</p>
          <p className={clsx('text-[11px] font-mono flex items-center gap-1 justify-end', flat ? 'text-slate-500' : up ? 'text-emerald-400' : 'text-red-400')}>
            {flat ? <Minus size={11} /> : up ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
            {change >= 0 ? '+' : ''}{formatMoney(change, { compact: true })}
            {data?.changePct != null && <span className="text-slate-600">({data.changePct >= 0 ? '+' : ''}{data.changePct.toFixed(1)}%)</span>}
          </p>
        </div>
      </div>

      {!data?.hasFeed || points.length === 0 ? (
        <div className="h-[64px] flex flex-col items-center justify-center text-center">
          <p className="text-xs text-slate-500">No feed history to chart yet.</p>
          <p className="text-[11px] text-slate-600 mt-0.5">Connect a bank or let transactions accumulate to see the trend.</p>
        </div>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-16">
            <defs>
              <linearGradient id="trendFillUp" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgb(16 185 129)" stopOpacity="0.25" />
                <stop offset="100%" stopColor="rgb(16 185 129)" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="trendFillDown" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgb(248 113 113)" stopOpacity="0.25" />
                <stop offset="100%" stopColor="rgb(248 113 113)" stopOpacity="0" />
              </linearGradient>
            </defs>
            {areaPath && !flat && <path d={areaPath} fill={`url(#${fillId})`} />}
            <path d={linePath} fill="none" className={strokeCls} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
          </svg>
          <div className="flex items-center justify-between text-[10px] text-slate-600 font-mono mt-1.5">
            <span>{points[0] && fmtShortDate(points[0].date)}</span>
            <span>Low {formatMoney(min, { compact: true })}</span>
            <span>{points[points.length - 1] && fmtShortDate(points[points.length - 1].date)}</span>
          </div>
        </>
      )}
    </div>
  );
}
