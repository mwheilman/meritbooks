'use client';

import { useMemo } from 'react';
import { FileText, TrendingUp, TrendingDown, Minus, ShieldCheck } from 'lucide-react';
import { clsx } from 'clsx';
import type { Mdna, KpiTrend, TrendMetric } from '@/lib/reports/board-package';

/**
 * Board Package — Management Discussion & Analysis (MD&A).
 *
 * Renders the deterministically-computed MD&A narrative. Every figure is derived
 * in code from the ledger (see buildMdna in board-package.ts); the honest
 * "Computed summary" label is surfaced so the reader knows nothing was AI-authored
 * or invented. Renders nothing when there are no blocks (fresh/empty ledger).
 */
export function MdnaSection({ mdna }: { mdna: Mdna | undefined }) {
  if (!mdna || mdna.blocks.length === 0) return null;
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-slate-500/15 flex items-center justify-center">
            <FileText size={14} className="text-slate-300" />
          </div>
          <div>
            <p className="text-sm font-semibold text-white">Management Discussion &amp; Analysis</p>
            <p className="text-[11px] text-slate-500">Results, key drivers, liquidity and receivables/payables health</p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium text-amber-300 bg-amber-500/10 shrink-0">
          <ShieldCheck size={10} /> Computed summary
        </span>
      </div>

      <div className="grid md:grid-cols-2 gap-x-6 gap-y-5">
        {mdna.blocks.map((b) => (
          <section key={b.id} aria-label={b.heading} className="min-w-0">
            <h4 className="text-[11px] uppercase tracking-wider text-emerald-400/90 font-semibold mb-1.5">{b.heading}</h4>
            {b.paragraphs.map((p, i) => (
              <p key={i} className="text-xs leading-relaxed text-slate-300 mb-1.5">{p}</p>
            ))}
            {b.bullets.length > 0 && (
              <ul className="mt-1 space-y-1">
                {b.bullets.map((bl, i) => (
                  <li key={i} className="text-xs leading-relaxed text-slate-400 flex gap-2">
                    <span className="text-emerald-500/70 mt-0.5 shrink-0" aria-hidden>•</span>
                    <span className="min-w-0">{bl}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
      <p className="mt-4 pt-3 border-t border-slate-800 text-[11px] text-slate-600">{mdna.label}</p>
    </div>
  );
}

/**
 * Board Package — KPI trend strip.
 *
 * A compact multi-period view of the headline metrics (revenue, gross margin %,
 * net income, cash) with an inline SVG sparkline per metric. All values are real,
 * pulled from trailing whole-month ledger aggregations. Renders nothing when the
 * series is empty.
 */
export function KpiTrendStrip({ trend }: { trend: KpiTrend | undefined }) {
  if (!trend || trend.metrics.length === 0 || trend.periods.length < 2) return null;
  const rangeLabel = `${trend.periods[0]} – ${trend.periods[trend.periods.length - 1]}`;
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <p className="text-[10px] uppercase tracking-wider text-slate-500">Trend · Last {trend.periods.length} Periods</p>
        <p className="text-[10px] text-slate-600 font-mono tabular-nums">{rangeLabel}</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {trend.metrics.map((m) => <TrendCard key={m.key} metric={m} />)}
      </div>
    </div>
  );
}

function TrendCard({ metric }: { metric: TrendMetric }) {
  const Icon = metric.direction === 'up' ? TrendingUp : metric.direction === 'down' ? TrendingDown : Minus;
  const dirColor = metric.favorable ? 'text-emerald-400' : 'text-red-400';
  const last = metric.points[metric.points.length - 1];
  return (
    <div className="card p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] uppercase tracking-wide text-slate-500">{metric.label}</p>
        {metric.deltaPct != null && (
          <span className={clsx('text-[10px] font-medium inline-flex items-center gap-0.5', dirColor)}>
            <Icon size={10} />
            {metric.deltaPct > 0 ? '+' : ''}{metric.deltaPct}%
          </span>
        )}
      </div>
      <p className="text-base font-mono font-semibold text-white mt-0.5 tabular-nums">{last.valueText}</p>
      <Sparkline metric={metric} />
    </div>
  );
}

/** Pure inline SVG sparkline. Normalizes the series into a 0..1 band; a flat
 *  series draws a centered line. Favorable trends draw emerald, else red. */
function Sparkline({ metric }: { metric: TrendMetric }) {
  const W = 120;
  const H = 30;
  const PAD = 2;
  const stroke = metric.favorable ? '#10b981' : '#ef4444';

  const { path, dot } = useMemo(() => {
    const vals = metric.points.map((p) => p.value);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min;
    const n = vals.length;
    const x = (i: number) => (n <= 1 ? W / 2 : PAD + (i * (W - 2 * PAD)) / (n - 1));
    const y = (v: number) => (span === 0 ? H / 2 : H - PAD - ((v - min) / span) * (H - 2 * PAD));
    const d = vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const li = n - 1;
    return { path: d, dot: { cx: x(li), cy: y(vals[li]) } };
  }, [metric.points]);

  const title = metric.points.map((p) => `${p.label}: ${p.valueText}`).join(' · ');

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height={H}
      className="mt-2 overflow-visible"
      role="img"
      aria-label={`${metric.label} trend, ${metric.direction}. ${title}`}
      preserveAspectRatio="none"
    >
      <title>{title}</title>
      <path d={path} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" opacity={0.9} />
      <circle cx={dot.cx} cy={dot.cy} r={2} fill={stroke} />
    </svg>
  );
}
