'use client';

import { Fragment, useMemo, useState, useCallback, useEffect, useRef } from 'react';
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
  SlidersHorizontal,
  ArrowUp,
  ArrowDown,
  Plus,
  X,
  GripVertical,
  RotateCcw,
  Check,
} from 'lucide-react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { useQuery } from '@/hooks';
import { useMe } from '@/lib/hooks/use-me';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { FpnaNlScenario } from './fpna-nl-scenario';
import {
  KPI_CATALOG,
  KPI_IDS,
  LAYOUTS,
  defaultConfig,
  applyLayout,
  deserializeConfig,
  serializeConfig,
  moveMetric,
  toggleMetric,
  setPeriodOffset,
  kpiConfigStorageKey,
  kpiMeta,
  type KpiId,
  type KpiGroup,
  type KpiDashboardConfig,
} from '@/lib/fpna/kpi-config';

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

// ── KPI id → real tile props (every figure comes from DashboardResponse) ───────

interface KpiTileProps {
  label: string;
  value: string;
  sub?: string;
  icon: typeof Wallet;
  tone?: 'default' | 'good' | 'danger' | 'warn';
  delta?: Delta;
  deltaKind?: 'money' | 'points' | 'ratio';
  higherIsBetter?: boolean;
}

/**
 * Map a catalog KPI id to the tile it renders, sourced entirely from the live
 * dashboard response (KPIs / runway / prior-period deltas). No fabricated
 * numbers — a metric the response can't supply is simply not in the catalog.
 */
function kpiTileProps(id: KpiId, data: DashboardResponse): KpiTileProps {
  const k = data.kpis;
  const d = data.deltas;
  const runway = data.runway;
  switch (id) {
    case 'revenue':
      return { label: 'Revenue (month)', value: formatMoney(k.revenueCents, { compact: true }), sub: 'current month', icon: Wallet, delta: d.revenue };
    case 'grossProfit':
      return { label: 'Gross profit', value: formatMoney(k.grossProfitCents, { compact: true }), sub: fmtPct(k.grossMarginPct) + ' margin', icon: Percent, tone: k.grossProfitCents >= 0 ? 'good' : 'danger', delta: d.grossProfit };
    case 'grossMargin':
      return { label: 'Gross margin', value: fmtPct(k.grossMarginPct), sub: `${formatMoney(k.grossProfitCents, { compact: true })} gross profit`, icon: Percent, tone: k.grossProfitCents >= 0 ? 'good' : 'danger', delta: d.grossMarginPct, deltaKind: 'points' };
    case 'cogs':
      return { label: 'Cost of goods sold', value: formatMoney(k.cogsCents, { compact: true }), sub: 'current month', icon: Landmark, higherIsBetter: false };
    case 'opex':
      return { label: 'Operating expenses', value: formatMoney(k.opexCents, { compact: true }), sub: 'current month', icon: Landmark, higherIsBetter: false };
    case 'operatingIncome':
      return { label: 'Operating income', value: formatMoney(k.operatingIncomeCents, { compact: true }), sub: fmtPct(k.operatingMarginPct) + ' margin', icon: k.operatingIncomeCents >= 0 ? TrendingUp : TrendingDown, tone: k.operatingIncomeCents >= 0 ? 'good' : 'danger', delta: d.operatingIncome };
    case 'operatingMargin':
      return { label: 'Operating margin', value: fmtPct(k.operatingMarginPct), sub: `${formatMoney(k.operatingIncomeCents, { compact: true })} op. income`, icon: Percent, tone: k.operatingIncomeCents >= 0 ? 'good' : 'danger' };
    case 'netIncome':
      return { label: 'Net income', value: formatMoney(k.netIncomeCents, { compact: true }), sub: fmtPct(k.netMarginPct) + ' net margin', icon: k.netIncomeCents >= 0 ? TrendingUp : TrendingDown, tone: k.netIncomeCents >= 0 ? 'good' : 'danger', delta: d.netIncome };
    case 'netMargin':
      return { label: 'Net margin', value: fmtPct(k.netMarginPct), sub: `${formatMoney(k.netIncomeCents, { compact: true })} net income`, icon: Percent, tone: k.netIncomeCents >= 0 ? 'good' : 'danger', delta: d.netMarginPct, deltaKind: 'points' };
    case 'cash':
      return { label: 'Cash', value: formatMoney(k.cashCents, { compact: true }), sub: 'as of period end', icon: Wallet, delta: d.cash };
    case 'monthlyBurn':
      return {
        label: 'Monthly burn',
        value: runway.cashGenerating ? 'Cash+' : formatMoney(runway.monthlyBurnCents, { compact: true }),
        sub: runway.cashGenerating ? 'generating cash' : `avg of ${runway.basisMonths} mo`,
        icon: Flame,
        tone: runway.cashGenerating ? 'good' : 'warn',
      };
    case 'runway':
      return {
        label: 'Runway',
        value: runway.runwayMonths === null ? '∞' : `${runway.runwayMonths.toFixed(1)} mo`,
        sub: runway.cashGenerating ? 'not burning' : 'cash ÷ burn',
        icon: Timer,
        tone: runway.runwayMonths !== null && runway.runwayMonths < 6 ? 'danger' : runway.runwayMonths !== null && runway.runwayMonths < 12 ? 'warn' : 'good',
      };
    case 'ar':
      return { label: 'Accounts receivable', value: formatMoney(k.arCents, { compact: true }), sub: 'as of period end', icon: Landmark, delta: d.ar, higherIsBetter: false };
    case 'ap':
      return { label: 'Accounts payable', value: formatMoney(k.apCents, { compact: true }), sub: 'as of period end', icon: Landmark, delta: d.ap, higherIsBetter: false };
    case 'workingCapital':
      return { label: 'Working capital', value: formatMoney(k.workingCapitalCents, { compact: true }), sub: 'current assets − liabilities', icon: Scale, tone: k.workingCapitalCents >= 0 ? 'good' : 'danger', delta: d.workingCapital };
    case 'currentRatio':
      return {
        label: 'Current ratio',
        value: fmtRatio(k.currentRatio),
        sub: `${formatMoney(k.workingCapitalCents, { compact: true })} working cap`,
        icon: Scale,
        tone: k.currentRatio === null ? 'default' : k.currentRatio >= 1.5 ? 'good' : k.currentRatio >= 1 ? 'warn' : 'danger',
        delta: d.currentRatio,
        deltaKind: 'ratio',
      };
  }
}

// ── Customize panel: toggle, reorder, pick default period, apply a layout ──────

const GROUP_ORDER: KpiGroup[] = ['Profitability', 'Liquidity & runway', 'Balance sheet'];

function monthOffsetLabel(offset: number): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offset);
  const label = d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
  if (offset === 0) return `Current month (${label})`;
  return `${-offset} mo ago (${label})`;
}

function CustomizePanel({
  config,
  onToggle,
  onMove,
  onApplyLayout,
  onReset,
  onSetPeriod,
  onClose,
}: {
  config: KpiDashboardConfig;
  onToggle: (id: KpiId) => void;
  onMove: (id: KpiId, dir: -1 | 1) => void;
  onApplyLayout: (layoutId: (typeof LAYOUTS)[number]['id']) => void;
  onReset: () => void;
  onSetPeriod: (offset: number) => void;
  onClose: () => void;
}) {
  const visibleSet = new Set(config.visible);
  const hiddenByGroup = useMemo(() => {
    const map: Record<string, KpiId[]> = {};
    for (const m of KPI_CATALOG) {
      if (visibleSet.has(m.id)) continue;
      (map[m.group] ??= []).push(m.id);
    }
    return map;
  }, [config.visible]);
  const hasHidden = KPI_IDS.some((id) => !visibleSet.has(id));

  return (
    <section
      className="card p-5 space-y-5"
      role="region"
      aria-label="Customize dashboard"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <SlidersHorizontal size={15} className="text-brand-400" />
          <h3 className="text-sm font-semibold text-white">Customize your KPI dashboard</h3>
        </div>
        <button
          onClick={onClose}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500/15 px-3 py-1.5 text-xs font-medium text-brand-300 hover:bg-brand-500/25"
        >
          <Check size={13} /> Done
        </button>
      </div>

      {/* Starter layouts */}
      <div>
        <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">Start from a layout</p>
        <div className="flex flex-wrap gap-2">
          {LAYOUTS.map((l) => (
            <button
              key={l.id}
              onClick={() => onApplyLayout(l.id)}
              title={l.description}
              className="group rounded-lg border border-slate-800 bg-surface-950 px-3 py-2 text-left hover:border-brand-500/40 hover:bg-slate-800/40"
            >
              <span className="block text-xs font-semibold text-slate-200 group-hover:text-white">{l.label}</span>
              <span className="block max-w-[220px] text-[10px] text-slate-500">{l.description}</span>
            </button>
          ))}
          <button
            onClick={onReset}
            className="inline-flex items-center gap-1.5 self-start rounded-lg border border-slate-800 bg-surface-950 px-3 py-2 text-xs font-medium text-slate-400 hover:border-slate-600 hover:text-white"
          >
            <RotateCcw size={13} /> Reset to default
          </button>
        </div>
      </div>

      {/* Default period */}
      <div>
        <label htmlFor="fpna-default-period" className="mb-2 block text-[11px] font-medium uppercase tracking-wide text-slate-500">
          Default period on open
        </label>
        <select
          id="fpna-default-period"
          value={config.periodOffset}
          onChange={(e) => onSetPeriod(Number(e.target.value))}
          className="w-full max-w-xs rounded-lg border border-slate-800 bg-surface-950 px-3 py-2 text-sm text-slate-200 focus:border-brand-500/50 focus:outline-none"
        >
          {Array.from({ length: 12 }, (_, i) => -i).map((off) => (
            <option key={off} value={off}>{monthOffsetLabel(off)}</option>
          ))}
        </select>
      </div>

      {/* Shown tiles (ordered) */}
      <div>
        <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
          Shown tiles · {config.visible.length}
        </p>
        <ul className="space-y-1.5" aria-label="Visible KPI tiles in display order">
          {config.visible.map((id, idx) => {
            const meta = kpiMeta(id);
            return (
              <li
                key={id}
                className="flex items-center gap-2 rounded-lg border border-slate-800 bg-surface-950 px-3 py-2"
              >
                <GripVertical size={13} className="shrink-0 text-slate-600" aria-hidden />
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-slate-200">{meta.label}</span>
                  <span className="block truncate text-[10px] text-slate-500">{meta.description}</span>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => onMove(id, -1)}
                    disabled={idx === 0}
                    aria-label={`Move ${meta.label} up`}
                    className="rounded-md p-1.5 text-slate-400 enabled:hover:bg-slate-800 enabled:hover:text-white disabled:opacity-25"
                  >
                    <ArrowUp size={13} />
                  </button>
                  <button
                    onClick={() => onMove(id, 1)}
                    disabled={idx === config.visible.length - 1}
                    aria-label={`Move ${meta.label} down`}
                    className="rounded-md p-1.5 text-slate-400 enabled:hover:bg-slate-800 enabled:hover:text-white disabled:opacity-25"
                  >
                    <ArrowDown size={13} />
                  </button>
                  <button
                    onClick={() => onToggle(id)}
                    disabled={config.visible.length <= 1}
                    aria-label={`Remove ${meta.label}`}
                    className="rounded-md p-1.5 text-slate-400 enabled:hover:bg-red-500/10 enabled:hover:text-red-400 disabled:opacity-25"
                  >
                    <X size={13} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Add tiles */}
      {hasHidden && (
        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">Add tiles</p>
          <div className="space-y-3">
            {GROUP_ORDER.map((group) => {
              const ids = hiddenByGroup[group];
              if (!ids || ids.length === 0) return null;
              return (
                <div key={group}>
                  <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-slate-600">{group}</p>
                  <div className="flex flex-wrap gap-2">
                    {ids.map((id) => {
                      const meta = kpiMeta(id);
                      return (
                        <button
                          key={id}
                          onClick={() => onToggle(id)}
                          title={meta.description}
                          aria-label={`Add ${meta.label}`}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-surface-950 px-2.5 py-1.5 text-xs text-slate-300 hover:border-brand-500/40 hover:text-white"
                        >
                          <Plus size={12} className="text-brand-400" /> {meta.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function FpnaDashboard() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [refreshKey, setRefreshKey] = useState(0);
  const [, forceTick] = useState(0);

  // ── Configurable KPI layout (persisted client-side per user + company) ──────
  const { user, loading: meLoading } = useMe();
  const { activeCompanyId, ready: companyReady } = useActiveCompany();
  const [config, setConfig] = useState<KpiDashboardConfig>(() => defaultConfig());
  const [customizing, setCustomizing] = useState(false);
  const hydratedRef = useRef(false);
  const appliedPeriodRef = useRef(false);

  const storageKey = useMemo(
    () => kpiConfigStorageKey(user?.clerkId ?? 'anon', activeCompanyId),
    [user?.clerkId, activeCompanyId],
  );

  // Hydrate the saved layout once identity + active company have resolved. Also
  // re-runs when the active company changes, loading that company's own layout.
  useEffect(() => {
    if (meLoading || !companyReady) return;
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(storageKey);
    } catch {
      /* storage unavailable (private mode) — fall back to default */
    }
    const next = deserializeConfig(stored);
    hydratedRef.current = true;
    appliedPeriodRef.current = false;
    setConfig(next);
  }, [meLoading, companyReady, storageKey]);

  // Persist on every change, but only after the initial hydration so we never
  // clobber a saved layout with the transient default.
  useEffect(() => {
    if (!hydratedRef.current) return;
    try {
      window.localStorage.setItem(storageKey, serializeConfig(config));
    } catch {
      /* storage unavailable — non-fatal */
    }
  }, [config, storageKey]);

  // Apply the saved default period offset once per hydration (the user can still
  // navigate months freely afterwards).
  useEffect(() => {
    if (!hydratedRef.current || appliedPeriodRef.current) return;
    appliedPeriodRef.current = true;
    if (config.periodOffset !== 0) {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() + config.periodOffset);
      setYear(d.getFullYear());
      setMonth(d.getMonth() + 1);
    }
  }, [config.periodOffset]);

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

  // Config mutators (all pure helpers → new config → persisted by the effect).
  const handleToggle = useCallback((id: KpiId) => setConfig((c) => toggleMetric(c, id)), []);
  const handleMove = useCallback((id: KpiId, dir: -1 | 1) => setConfig((c) => moveMetric(c, id, dir)), []);
  const handleApplyLayout = useCallback(
    (layoutId: (typeof LAYOUTS)[number]['id']) => setConfig((c) => applyLayout(layoutId, c.periodOffset)),
    [],
  );
  const handleReset = useCallback(() => setConfig(() => defaultConfig()), []);
  const handleSetPeriod = useCallback((offset: number) => {
    setConfig((c) => setPeriodOffset(c, offset));
    if (offset !== 0) {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() + offset);
      setYear(d.getFullYear());
      setMonth(d.getMonth() + 1);
    } else {
      setYear(now.getFullYear());
      setMonth(now.getMonth() + 1);
    }
  }, [now]);

  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1;
  const k = data?.kpis;
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
            onClick={() => setCustomizing((v) => !v)}
            aria-pressed={customizing}
            aria-label="Customize KPI tiles"
            className={clsx(
              'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium',
              customizing
                ? 'border-brand-500/40 bg-brand-500/15 text-brand-300'
                : 'border-slate-800 bg-surface-900 text-slate-300 hover:bg-slate-800 hover:text-white',
            )}
          >
            <SlidersHorizontal size={13} />
            Customize
          </button>
          <button
            onClick={() => { setRefreshKey((x) => x + 1); refetch(); }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-surface-900 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800 hover:text-white"
          >
            <RefreshCw size={13} className={clsx(isLoading && 'animate-spin')} />
            Refresh
          </button>
        </div>
      </div>

      {customizing && (
        <CustomizePanel
          config={config}
          onToggle={handleToggle}
          onMove={handleMove}
          onApplyLayout={handleApplyLayout}
          onReset={handleReset}
          onSetPeriod={handleSetPeriod}
          onClose={() => setCustomizing(false)}
        />
      )}

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
          {/* Configurable KPI strip — renders only the selected tiles, in the
              chosen order. Every tile is computed from the live dashboard
              response (kpiTileProps); nothing is fabricated. Unknown/removed
              ids were already dropped when the config was hydrated. */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
            {config.visible.map((id) => {
              const props = kpiTileProps(id, data);
              return <Kpi key={id} {...props} />;
            })}
          </div>

          {!data.meta.hasBudget && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-2.5 text-[11px] text-amber-300/90">
              No budget is set for {data.period.fiscalYear}. The variance table shows actuals and forecast; set a budget in{' '}
              <Link href={budgetDrill} className="underline hover:text-amber-200">Budgets</Link> to measure plan variance.
            </div>
          )}

          {/* AI what-if — REAL natural-language scenario modeling on the active
              company's driver budget (indigo = AI). Heuristic-backed when the AI
              provider is unavailable, so it always returns a modeled result. */}
          <FpnaNlScenario fiscalYear={data.period.fiscalYear} />

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
