'use client';

import { Fragment, useMemo, useState, useCallback, useEffect } from 'react';
import Link from 'next/link';
import {
  Loader2,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Minus,
  Wallet,
  Flame,
  Timer,
  Percent,
  Landmark,
  Scale,
  BarChart3,
  ArrowRight,
  Sparkles,
  Wand2,
} from 'lucide-react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { useQuery } from '@/hooks';

// ── Response types (mirror /api/fpna/dashboard) ──────────────────────────────

interface Delta {
  currentCents: number;
  priorCents: number;
  deltaCents: number;
  pct: number | null;
}
interface Kpis {
  revenueCents: number;
  cogsCents: number;
  grossProfitCents: number;
  grossMarginPct: number | null;
  opexCents: number;
  operatingIncomeCents: number;
  operatingMarginPct: number | null;
  otherCents: number;
  netIncomeCents: number;
  netMarginPct: number | null;
  cashCents: number;
  arCents: number;
  apCents: number;
  currentAssetsCents: number;
  currentLiabilitiesCents: number;
  workingCapitalCents: number;
  currentRatio: number | null;
}
interface RunwayResult {
  cashCents: number;
  monthlyBurnCents: number;
  runwayMonths: number | null;
  cashGenerating: boolean;
  basisMonths: number;
}
type Section = 'REVENUE' | 'COGS' | 'OPEX' | 'OTHER';
interface VarianceRow {
  key: string;
  label: string;
  section: Section;
  actualCents: number;
  budgetCents: number;
  forecastCents: number;
  budgetVarianceCents: number;
  budgetVariancePct: number | null;
  forecastVarianceCents: number;
  forecastVariancePct: number | null;
  favorable: boolean | null;
  forecastFavorable: boolean | null;
}
interface VarianceTotalRow {
  section: Section | 'NET_INCOME';
  actualCents: number;
  budgetCents: number;
  forecastCents: number;
  budgetVarianceCents: number;
  budgetVariancePct: number | null;
  forecastVarianceCents: number;
  forecastVariancePct: number | null;
  favorable: boolean | null;
  forecastFavorable: boolean | null;
}
interface TrendPoint {
  label: string;
  revenueCents: number;
  grossProfitCents: number;
  operatingIncomeCents: number;
  netIncomeCents: number;
  grossMarginPct: number | null;
  netMarginPct: number | null;
  cashCents: number | null;
}
interface DashboardResponse {
  period: { fiscalYear: number; asOfMonth: number; asOfDate: string; label: string; forecastMethod: string };
  kpis: Kpis;
  priorKpis: Kpis | null;
  deltas: Record<string, Delta>;
  runway: RunwayResult;
  variance: { rows: VarianceRow[]; totalsBySection: VarianceTotalRow[]; netIncome: VarianceTotalRow };
  trend: TrendPoint[];
  filters: { locationIds: string[]; departmentId: string | null };
  meta: { accountCount: number; hasBudget: boolean; generatedAt: string };
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmtPct(p: number | null, digits = 1): string {
  if (p === null) return '—';
  return `${p.toFixed(digits)}%`;
}
function fmtRatio(r: number | null): string {
  if (r === null) return '—';
  return `${r.toFixed(2)}×`;
}
function moneyTone(cents: number): string {
  if (cents > 0) return 'text-emerald-400';
  if (cents < 0) return 'text-red-400';
  return 'text-slate-500';
}
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const sec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.round(min / 60)}h ago`;
}

const SECTION_LABEL: Record<Section | 'NET_INCOME', string> = {
  REVENUE: 'Revenue',
  COGS: 'Cost of Goods Sold',
  OPEX: 'Operating Expenses',
  OTHER: 'Other Income / Expense',
  NET_INCOME: 'Net Income',
};

// ── Delta pill ────────────────────────────────────────────────────────────────

function DeltaPill({
  delta,
  kind,
  higherIsBetter = true,
}: {
  delta?: Delta;
  kind: 'money' | 'points' | 'ratio';
  higherIsBetter?: boolean;
}) {
  if (!delta) return null;
  const d = delta.deltaCents;
  if (d === 0) {
    return (
      <span className="inline-flex items-center gap-0.5 text-[11px] text-slate-500">
        <Minus size={11} /> flat
      </span>
    );
  }
  const good = higherIsBetter ? d > 0 : d < 0;
  const tone = good ? 'text-emerald-400' : 'text-red-400';
  const Icon = d > 0 ? TrendingUp : TrendingDown;
  const magnitude =
    kind === 'money'
      ? formatMoney(Math.abs(d), { compact: true })
      : kind === 'ratio'
        ? `${(Math.abs(d) / 1).toFixed(2)}×`
        : `${(Math.abs(d)).toFixed(1)} pts`;
  const pct = delta.pct !== null && kind === 'money' ? ` (${delta.pct > 0 ? '+' : ''}${delta.pct.toFixed(1)}%)` : '';
  return (
    <span className={clsx('inline-flex items-center gap-0.5 text-[11px] font-medium', tone)}>
      <Icon size={11} />
      {d > 0 ? '+' : '−'}
      {magnitude}
      <span className="text-slate-500">{pct}</span>
    </span>
  );
}

// ── KPI tile ──────────────────────────────────────────────────────────────────

function Kpi({
  label,
  value,
  sub,
  icon: Icon,
  tone = 'default',
  delta,
  deltaKind = 'money',
  higherIsBetter = true,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: typeof Wallet;
  tone?: 'default' | 'good' | 'danger' | 'warn';
  delta?: Delta;
  deltaKind?: 'money' | 'points' | 'ratio';
  higherIsBetter?: boolean;
}) {
  const iconTone =
    tone === 'danger' ? 'bg-red-500/10 text-red-400'
    : tone === 'warn' ? 'bg-amber-500/10 text-amber-400'
    : tone === 'good' ? 'bg-emerald-500/10 text-emerald-400'
    : 'bg-brand-500/10 text-brand-400';
  return (
    <div className="card p-4">
      <div className="flex items-start justify-between">
        <p className="text-xs text-slate-400">{label}</p>
        <div className={clsx('flex h-7 w-7 items-center justify-center rounded-lg', iconTone)}>
          <Icon size={14} />
        </div>
      </div>
      <p className="mt-2 font-mono text-2xl font-semibold tabular-nums tracking-tight text-white">{value}</p>
      <div className="mt-1 flex items-center justify-between gap-2">
        {sub ? <p className="text-[11px] text-slate-500">{sub}</p> : <span />}
        <DeltaPill delta={delta} kind={deltaKind} higherIsBetter={higherIsBetter} />
      </div>
    </div>
  );
}

// ── Trend chart: revenue bars + net-income line (inline SVG) ───────────────────

function TrendChart({ trend, throughMonth }: { trend: TrendPoint[]; throughMonth: number }) {
  if (trend.length === 0) return null;
  const W = 1000;
  const H = 260;
  const padL = 8;
  const padR = 8;
  const padT = 16;
  const padB = 24;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const n = trend.length;
  const slot = plotW / n;
  const barW = Math.min(slot * 0.5, 42);

  const maxRev = Math.max(1, ...trend.map((t) => t.revenueCents));
  const niValues = trend.map((t) => t.netIncomeCents);
  const maxNi = Math.max(0, ...niValues);
  const minNi = Math.min(0, ...niValues);
  const niRange = Math.max(1, maxNi - minNi);
  const revY = (c: number) => padT + plotH - (c / maxRev) * plotH;
  const niY = (c: number) => padT + plotH - ((c - minNi) / niRange) * plotH;

  const linePts = trend.map((t, i) => `${padL + slot * i + slot / 2},${niY(t.netIncomeCents)}`).join(' ');

  return (
    <div className="card p-5">
      <div className="mb-3 flex items-center gap-2">
        <BarChart3 size={15} className="text-brand-400" />
        <h3 className="text-sm font-semibold text-white">Revenue &amp; net income by month</h3>
        <span className="text-[11px] text-slate-500">bars = revenue · line = net income</span>
      </div>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Revenue and net income by month" style={{ minWidth: 560 }}>
          {/* zero line for net income */}
          <line x1={padL} y1={niY(0)} x2={W - padR} y2={niY(0)} stroke="#1e293b" strokeWidth={1} />
          {trend.map((t, i) => {
            const x = padL + slot * i + slot / 2;
            const bh = padT + plotH - revY(t.revenueCents);
            const isFuture = i + 1 > throughMonth;
            return (
              <g key={t.label}>
                <rect
                  x={x - barW / 2}
                  y={revY(t.revenueCents)}
                  width={barW}
                  height={Math.max(0, bh)}
                  rx={2}
                  fill={isFuture ? '#1e40af' : '#10b981'}
                  opacity={isFuture ? 0.35 : 0.75}
                />
                <text x={x} y={H - 8} textAnchor="middle" fontSize={10} fill="#64748b">{t.label}</text>
              </g>
            );
          })}
          {/* net income line */}
          <polyline points={linePts} fill="none" stroke="#818cf8" strokeWidth={2} />
          {trend.map((t, i) => {
            const x = padL + slot * i + slot / 2;
            return <circle key={t.label} cx={x} cy={niY(t.netIncomeCents)} r={2.5} fill={t.netIncomeCents >= 0 ? '#818cf8' : '#ef4444'} />;
          })}
        </svg>
      </div>
    </div>
  );
}

// ── Margin sparkline (gross margin % over time) ────────────────────────────────

function MarginTrend({ trend }: { trend: TrendPoint[] }) {
  const pts = trend.filter((t) => t.grossMarginPct !== null);
  if (pts.length < 2) return null;
  const W = 1000;
  const H = 120;
  const padL = 8, padR = 8, padT = 12, padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const values = trend.map((t) => t.grossMarginPct);
  const known = values.filter((v): v is number => v !== null);
  const maxV = Math.max(...known);
  const minV = Math.min(...known, 0);
  const range = Math.max(1, maxV - minV);
  const n = trend.length;
  const slot = plotW / n;
  const y = (v: number) => padT + plotH - ((v - minV) / range) * plotH;
  const line = trend
    .map((t, i) => (t.grossMarginPct === null ? null : `${padL + slot * i + slot / 2},${y(t.grossMarginPct)}`))
    .filter(Boolean)
    .join(' ');

  return (
    <div className="card p-5">
      <div className="mb-3 flex items-center gap-2">
        <Percent size={15} className="text-brand-400" />
        <h3 className="text-sm font-semibold text-white">Gross margin trend</h3>
      </div>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Gross margin trend" style={{ minWidth: 560 }}>
          <polyline points={line} fill="none" stroke="#10b981" strokeWidth={2} />
          {trend.map((t, i) =>
            t.grossMarginPct === null ? null : (
              <g key={t.label}>
                <circle cx={padL + slot * i + slot / 2} cy={y(t.grossMarginPct)} r={2.5} fill="#10b981" />
                <text x={padL + slot * i + slot / 2} y={H - 6} textAnchor="middle" fontSize={10} fill="#64748b">{t.label}</text>
              </g>
            ),
          )}
        </svg>
      </div>
    </div>
  );
}

// ── Variance table ────────────────────────────────────────────────────────────

function favTone(fav: boolean | null): string {
  if (fav === null) return 'text-slate-400';
  return fav ? 'text-emerald-400' : 'text-red-400';
}

function VarianceTable({
  data,
  drillHref,
}: {
  data: DashboardResponse['variance'];
  drillHref: string;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const rowsBySection = useMemo(() => {
    const map: Record<string, VarianceRow[]> = {};
    for (const r of data.rows) {
      (map[r.section] ??= []).push(r);
    }
    for (const k of Object.keys(map)) {
      map[k].sort((a, b) => Math.abs(b.forecastVarianceCents) - Math.abs(a.forecastVarianceCents));
    }
    return map;
  }, [data.rows]);

  const sectionOrder: Section[] = ['REVENUE', 'COGS', 'OPEX', 'OTHER'];

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-800/60 px-5 py-3">
        <div className="flex items-center gap-2">
          <Scale size={15} className="text-brand-400" />
          <h3 className="text-sm font-semibold text-white">Plan variance — actual vs budget vs forecast</h3>
        </div>
        <Link href={drillHref} className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-white">
          Budget vs actual <ArrowRight size={11} />
        </Link>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800/60 text-left text-[11px] text-slate-500">
              <th className="px-5 py-2.5 font-medium">Account</th>
              <th className="px-3 py-2.5 text-right font-medium">Actual YTD</th>
              <th className="px-3 py-2.5 text-right font-medium">Budget (FY)</th>
              <th className="px-3 py-2.5 text-right font-medium">Forecast (FY)</th>
              <th className="px-3 py-2.5 text-right font-medium">Fcst vs Budget</th>
              <th className="px-5 py-2.5 text-right font-medium">%</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/40">
            {sectionOrder.map((section) => {
              const total = data.totalsBySection.find((t) => t.section === section);
              if (!total) return null;
              const accountRows = rowsBySection[section] ?? [];
              const isOpen = expanded[section];
              return (
                <Fragment key={section}>
                  <tr
                    className="cursor-pointer bg-surface-950/40 text-slate-200 hover:bg-slate-800/30"
                    onClick={() => setExpanded((e) => ({ ...e, [section]: !e[section] }))}
                  >
                    <td className="px-5 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-300">
                      <span className="inline-flex items-center gap-1.5">
                        <ChevronDown size={13} className={clsx('transition-transform', !isOpen && '-rotate-90')} />
                        {SECTION_LABEL[section]}
                        <span className="text-[10px] font-normal text-slate-600">({accountRows.length})</span>
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-300">{formatMoney(total.actualCents)}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-400">{formatMoney(total.budgetCents)}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-300">{formatMoney(total.forecastCents)}</td>
                    <td className={clsx('px-3 py-2.5 text-right font-mono tabular-nums', favTone(total.forecastFavorable))}>{formatMoney(total.forecastVarianceCents)}</td>
                    <td className={clsx('px-5 py-2.5 text-right font-mono tabular-nums', favTone(total.forecastFavorable))}>{fmtPct(total.forecastVariancePct)}</td>
                  </tr>
                  {isOpen &&
                    accountRows.map((r) => (
                      <tr key={`${section}-${r.key}`} className="text-slate-400 hover:bg-slate-800/20">
                        <td className="px-5 py-2 pl-11">
                          <span className="font-mono text-[10px] text-slate-600">{r.key}</span>{' '}
                          <span className="text-slate-300">{r.label}</span>
                        </td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">{formatMoney(r.actualCents)}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-500">{formatMoney(r.budgetCents)}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">{formatMoney(r.forecastCents)}</td>
                        <td className={clsx('px-3 py-2 text-right font-mono tabular-nums', favTone(r.forecastFavorable))}>{formatMoney(r.forecastVarianceCents)}</td>
                        <td className={clsx('px-5 py-2 text-right font-mono tabular-nums', favTone(r.forecastFavorable))}>{fmtPct(r.forecastVariancePct)}</td>
                      </tr>
                    ))}
                </Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t border-slate-700/60 bg-surface-950/60 text-slate-100">
              <td className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-300">{SECTION_LABEL.NET_INCOME}</td>
              <td className={clsx('px-3 py-3 text-right font-mono tabular-nums font-semibold', moneyTone(data.netIncome.actualCents))}>{formatMoney(data.netIncome.actualCents)}</td>
              <td className="px-3 py-3 text-right font-mono tabular-nums text-slate-400">{formatMoney(data.netIncome.budgetCents)}</td>
              <td className={clsx('px-3 py-3 text-right font-mono tabular-nums font-semibold', moneyTone(data.netIncome.forecastCents))}>{formatMoney(data.netIncome.forecastCents)}</td>
              <td className={clsx('px-3 py-3 text-right font-mono tabular-nums font-semibold', favTone(data.netIncome.forecastFavorable))}>{formatMoney(data.netIncome.forecastVarianceCents)}</td>
              <td className={clsx('px-5 py-3 text-right font-mono tabular-nums', favTone(data.netIncome.forecastFavorable))}>{fmtPct(data.netIncome.forecastVariancePct)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function FpnaDashboard() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [refreshKey, setRefreshKey] = useState(0);
  const [, forceTick] = useState(0);

  const { data, isLoading, error, refetch } = useQuery<DashboardResponse>(
    '/api/fpna/dashboard',
    { fiscal_year: String(year), as_of_month: String(month) },
    { key: String(refreshKey), refetchInterval: 120_000 },
  );

  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  const stepMonth = useCallback((delta: number) => {
    const d = new Date(year, month - 1 + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth() + 1);
  }, [year, month]);

  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1;
  const k = data?.kpis;
  const deltas = data?.deltas ?? {};
  const drillBase = useMemo(() => {
    if (!data) return '/reports';
    const start = `${data.period.fiscalYear}-${String(data.period.asOfMonth).padStart(2, '0')}-01`;
    return `/reports?start_date=${start}&end_date=${data.period.asOfDate}`;
  }, [data]);
  const budgetDrill = data ? `/budgets?fiscal_year=${data.period.fiscalYear}` : '/budgets';

  return (
    <div className="space-y-5">
      {/* Period selector + refresh */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-surface-900 p-1">
          <button onClick={() => stepMonth(-1)} className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white" aria-label="Previous month">
            <ChevronLeft size={16} />
          </button>
          <span className="min-w-[10rem] px-2 text-center text-sm font-medium text-white">
            {data?.period.label ?? new Date(year, month - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' })}
          </span>
          <button onClick={() => stepMonth(1)} disabled={isCurrentMonth} className="rounded-md p-1.5 text-slate-400 enabled:hover:bg-slate-800 enabled:hover:text-white disabled:opacity-30" aria-label="Next month">
            <ChevronRight size={16} />
          </button>
        </div>
        <div className="flex items-center gap-3">
          {data && <span className="text-[11px] text-slate-500">Updated {relativeTime(data.meta.generatedAt)}</span>}
          <button
            onClick={() => { setRefreshKey((x) => x + 1); refetch(); }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-surface-900 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800 hover:text-white"
          >
            <RefreshCw size={13} className={clsx(isLoading && 'animate-spin')} />
            Refresh
          </button>
        </div>
      </div>

      {isLoading && !data ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-emerald-400" />
        </div>
      ) : error ? (
        <div className="card p-10 text-center">
          <AlertCircle className="mx-auto mb-2 h-8 w-8 text-red-400" />
          <p className="text-sm text-red-400">{error}</p>
          <button onClick={() => { setRefreshKey((x) => x + 1); refetch(); }} className="mt-4 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800">
            Try again
          </button>
        </div>
      ) : !k ? (
        <div className="card p-12 text-center">
          <BarChart3 className="mx-auto mb-3 h-8 w-8 text-slate-600" />
          <p className="text-sm font-medium text-slate-300">No data to report on</p>
          <p className="mt-1 text-xs text-slate-500">Post GL activity and set budgets to light up the dashboard.</p>
        </div>
      ) : (
        <>
          {/* Profitability KPIs */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Revenue (month)" value={formatMoney(k.revenueCents, { compact: true })} sub="current month" icon={Wallet} delta={deltas.revenue} />
            <Kpi label="Gross margin" value={fmtPct(k.grossMarginPct)} sub={`${formatMoney(k.grossProfitCents, { compact: true })} gross profit`} icon={Percent} tone={k.grossProfitCents >= 0 ? 'good' : 'danger'} delta={deltas.grossMarginPct} deltaKind="points" />
            <Kpi label="Operating income" value={formatMoney(k.operatingIncomeCents, { compact: true })} sub={fmtPct(k.operatingMarginPct) + ' margin'} icon={k.operatingIncomeCents >= 0 ? TrendingUp : TrendingDown} tone={k.operatingIncomeCents >= 0 ? 'good' : 'danger'} delta={deltas.operatingIncome} />
            <Kpi label="Net income" value={formatMoney(k.netIncomeCents, { compact: true })} sub={fmtPct(k.netMarginPct) + ' net margin'} icon={k.netIncomeCents >= 0 ? TrendingUp : TrendingDown} tone={k.netIncomeCents >= 0 ? 'good' : 'danger'} delta={deltas.netIncome} />
          </div>

          {/* Liquidity + runway KPIs */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            <Kpi label="Cash" value={formatMoney(k.cashCents, { compact: true })} icon={Wallet} delta={deltas.cash} />
            <Kpi
              label="Monthly burn"
              value={data.runway.cashGenerating ? 'Cash+' : formatMoney(data.runway.monthlyBurnCents, { compact: true })}
              sub={data.runway.cashGenerating ? 'generating cash' : `avg of ${data.runway.basisMonths} mo`}
              icon={Flame}
              tone={data.runway.cashGenerating ? 'good' : 'warn'}
            />
            <Kpi
              label="Runway"
              value={data.runway.runwayMonths === null ? '∞' : `${data.runway.runwayMonths.toFixed(1)} mo`}
              sub={data.runway.cashGenerating ? 'not burning' : 'cash ÷ burn'}
              icon={Timer}
              tone={data.runway.runwayMonths !== null && data.runway.runwayMonths < 6 ? 'danger' : data.runway.runwayMonths !== null && data.runway.runwayMonths < 12 ? 'warn' : 'good'}
            />
            <Kpi label="Accounts receivable" value={formatMoney(k.arCents, { compact: true })} icon={Landmark} delta={deltas.ar} higherIsBetter={false} />
            <Kpi label="Accounts payable" value={formatMoney(k.apCents, { compact: true })} icon={Landmark} delta={deltas.ap} higherIsBetter={false} />
            <Kpi
              label="Current ratio"
              value={fmtRatio(k.currentRatio)}
              sub={`${formatMoney(k.workingCapitalCents, { compact: true })} working cap`}
              icon={Scale}
              tone={k.currentRatio === null ? 'default' : k.currentRatio >= 1.5 ? 'good' : k.currentRatio >= 1 ? 'warn' : 'danger'}
              delta={deltas.currentRatio}
              deltaKind="ratio"
            />
          </div>

          {!data.meta.hasBudget && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-2.5 text-[11px] text-amber-300/90">
              No budget is set for {data.period.fiscalYear}. The variance table shows actuals and forecast; set a budget in{' '}
              <Link href={budgetDrill} className="underline hover:text-amber-200">Budgets</Link> to measure plan variance.
            </div>
          )}

          {/* AI what-if — natural-language scenario modeling (indigo = AI) */}
          <Link
            href={`/budgets?tab=scenarios&fiscal_year=${data.period.fiscalYear}`}
            className="group flex items-center gap-3 rounded-xl border border-indigo-500/30 bg-indigo-500/[0.06] px-4 py-3 transition-colors hover:border-indigo-500/50 hover:bg-indigo-500/10"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/15">
              <Sparkles size={16} className="text-indigo-300" />
            </div>
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-sm font-medium text-white">
                <Wand2 size={13} className="text-indigo-300" /> Model a what-if in plain English
              </p>
              <p className="truncate text-[11px] text-slate-400">
                “Raise revenue 8% and cut headcount cost 12% starting Q3” — AI turns it into a modeled scenario on your driver budget.
              </p>
            </div>
            <ArrowRight size={15} className="ml-auto shrink-0 text-slate-500 transition-transform group-hover:translate-x-0.5 group-hover:text-indigo-300" />
          </Link>

          {/* Trends */}
          <TrendChart trend={data.trend} throughMonth={data.period.asOfMonth} />
          <MarginTrend trend={data.trend} />

          {/* Variance */}
          <VarianceTable data={data.variance} drillHref={budgetDrill} />

          <p className="text-[11px] leading-relaxed text-slate-600">
            KPIs are for {data.period.label} with deltas vs the prior month. Cash, AR, AP, and the current
            ratio are balance-sheet snapshots as of {data.period.asOfDate}. Burn is the average monthly net
            income across elapsed months; runway = cash ÷ burn. The variance table compares actuals booked so
            far this year against the full-year budget and the rolling forecast ({data.period.forecastMethod === 'run_rate' ? 'run-rate' : 'budget-remaining'} method).
            Everything is read live from posted GL entries — reuse the same account-type math as the financial statements.{' '}
            <Link href={drillBase} className="underline hover:text-slate-400">Open the full statements</Link>.
          </p>
        </>
      )}
    </div>
  );
}
