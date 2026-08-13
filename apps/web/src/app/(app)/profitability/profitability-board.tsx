'use client';

import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import Link from 'next/link';
import {
  Loader2,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  ArrowUpDown,
  BarChart3,
  TrendingUp,
  TrendingDown,
  Wallet,
  Building2,
  Layers,
} from 'lucide-react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { useQuery } from '@/hooks';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { isSpecificCompany } from '@/lib/company-scope';

// ── Types (mirror /api/profitability) ───────────────────────────────────────────

interface EntityRow {
  locationId: string;
  name: string;
  shortCode: string;
  revenueCents: number;
  cogsCents: number;
  grossProfitCents: number;
  opexCents: number;
  otherCents: number;
  netIncomeCents: number;
  grossMarginPct: number | null;
  netMarginPct: number | null;
  hasActivity: boolean;
}
interface Rollup {
  revenueCents: number;
  cogsCents: number;
  grossProfitCents: number;
  opexCents: number;
  otherCents: number;
  netIncomeCents: number;
  grossMarginPct: number | null;
  netMarginPct: number | null;
  entityCount: number;
  activeCount: number;
  profitableCount: number;
  unprofitableCount: number;
}
interface ProfitabilityResponse {
  period: { startDate: string; endDate: string; label: string };
  generatedAt: string;
  rollup: Rollup;
  entities: EntityRow[];
}

type SortKey = 'name' | 'revenue' | 'grossProfit' | 'opex' | 'netIncome' | 'netMargin';

// ── Helpers ──────────────────────────────────────────────────────────────────────

function fmtPct(p: number | null): string {
  if (p === null) return '—';
  return `${p.toFixed(1)}%`;
}
function marginTone(p: number | null): string {
  if (p === null) return 'text-slate-600';
  return p >= 0 ? 'text-emerald-400' : 'text-red-400';
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

// ── Stat tile ──────────────────────────────────────────────────────────────────

function StatTile({
  label, value, hint, icon: Icon, tone = 'default',
}: {
  label: string;
  value: string;
  hint?: string;
  icon: typeof Wallet;
  tone?: 'default' | 'good' | 'danger' | 'warn';
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
      {hint && <p className="mt-1 text-[11px] text-slate-500">{hint}</p>}
    </div>
  );
}

// ── Diverging net-income bar chart (inline SVG) ──────────────────────────────────

function NetIncomeChart({ entities, highlightId }: { entities: EntityRow[]; highlightId?: string | null }) {
  const rows = entities.filter((e) => e.hasActivity);
  if (rows.length === 0) return null;

  // Rank most-profitable → least so winners sit on top, losers at the bottom.
  const sorted = [...rows].sort((a, b) => b.netIncomeCents - a.netIncomeCents);
  const maxAbs = Math.max(1, ...sorted.map((e) => Math.abs(e.netIncomeCents)));

  const W = 1000;
  const rowH = 26;
  const padT = 8;
  const padB = 8;
  const labelW = 210;
  const valueW = 130;
  const plotW = W - labelW - valueW;
  const zeroX = labelW + plotW / 2;
  const H = padT + padB + sorted.length * rowH;

  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  return (
    <div className="card p-5">
      <div className="mb-3 flex items-center gap-2">
        <BarChart3 size={15} className="text-brand-400" />
        <h3 className="text-sm font-semibold text-white">Net income by entity</h3>
        <span className="text-[11px] text-slate-500">emerald = profit · red = loss</span>
      </div>
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="Net income by entity"
          style={{ minWidth: 520 }}
        >
          {/* zero axis */}
          <line x1={zeroX} y1={padT} x2={zeroX} y2={H - padB} stroke="#232C27" strokeWidth={1} />
          {sorted.map((e, i) => {
            const y = padT + i * rowH;
            const cy = y + rowH / 2;
            const ni = e.netIncomeCents;
            const len = (Math.abs(ni) / maxAbs) * (plotW / 2 - 6);
            const positive = ni >= 0;
            const barX = positive ? zeroX : zeroX - len;
            const fill = ni > 0 ? '#10b981' : ni < 0 ? '#ef4444' : '#2C362F';
            const isFocus = highlightId != null && e.locationId === highlightId;
            const dim = highlightId != null && !isFocus;
            return (
              <g key={e.locationId}>
                <text
                  x={labelW - 10}
                  y={cy}
                  textAnchor="end"
                  dominantBaseline="central"
                  fontSize={12}
                  fontWeight={isFocus ? 600 : 400}
                  fill={isFocus ? '#EDF2EF' : '#AEB8B2'}
                  opacity={dim ? 0.5 : 1}
                >
                  {clip(e.name, 30)}
                </text>
                <rect
                  x={barX}
                  y={y + 5}
                  width={Math.max(len, ni === 0 ? 0 : 1.5)}
                  height={rowH - 10}
                  rx={2}
                  fill={fill}
                  opacity={dim ? 0.3 : 0.9}
                />
                <text
                  x={W - 8}
                  y={cy}
                  textAnchor="end"
                  dominantBaseline="central"
                  fontSize={11}
                  fontFamily="'JetBrains Mono', monospace"
                  fill={ni >= 0 ? '#34d399' : '#f87171'}
                  opacity={dim ? 0.4 : 1}
                >
                  {formatMoney(ni, { compact: true })}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

// ── Sort header ──────────────────────────────────────────────────────────────────

function SortHeader({
  label, active, dir, onClick, align = 'left',
}: { label: string; active: boolean; dir: 'asc' | 'desc'; onClick: () => void; align?: 'left' | 'right' }) {
  return (
    <button
      onClick={onClick}
      className={clsx('inline-flex items-center gap-1 hover:text-slate-300', active && 'text-slate-300', align === 'right' && 'flex-row-reverse')}
    >
      {label}
      <ArrowUpDown size={11} className={clsx(active ? 'text-emerald-400' : 'text-slate-600', active && dir === 'asc' && 'rotate-180')} />
    </button>
  );
}

// ── Main board ────────────────────────────────────────────────────────────────────

export function ProfitabilityBoard() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1); // 1-12
  const [sortKey, setSortKey] = useState<SortKey>('netIncome');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [refreshKey, setRefreshKey] = useState(0);
  const [, forceTick] = useState(0);

  // The header already knows the active company; this ranking board is inherently
  // cross-entity, so we DON'T scope the fetch (scope:false — always pull every
  // entity for the ranking) but we DO default the on-page view to the active
  // company: a specific company starts "focused" on itself (with its rank among
  // peers); "All" starts on the full consolidated board. A toggle switches views.
  const { activeCompanyId, activeCompany, isAll } = useActiveCompany();
  const [focusMode, setFocusMode] = useState<'focused' | 'all'>(
    () => (isSpecificCompany(activeCompanyId) ? 'focused' : 'all'),
  );
  const userPickedFocus = useRef(false);
  useEffect(() => {
    if (userPickedFocus.current) return; // in-page choice wins once made
    setFocusMode(!isAll && isSpecificCompany(activeCompanyId) ? 'focused' : 'all');
  }, [activeCompanyId, isAll]);
  const pickFocus = useCallback((m: 'focused' | 'all') => {
    userPickedFocus.current = true;
    setFocusMode(m);
  }, []);

  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = new Date(year, month, 0).toISOString().split('T')[0]; // last day of month

  const { data, isLoading, error, refetch } = useQuery<ProfitabilityResponse>(
    '/api/profitability',
    { start_date: startDate, end_date: endDate },
    { key: String(refreshKey), refetchInterval: 120_000, scope: false },
  );

  // Keep the "updated Xs ago" label honest between fetches.
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  const stepMonth = useCallback((delta: number) => {
    const d = new Date(year, month - 1 + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth() + 1);
  }, [year, month]);

  const setSort = useCallback((key: SortKey) => {
    setSortKey((prev) => {
      if (prev === key) {
        setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
        return prev;
      }
      setSortDir(key === 'name' ? 'asc' : 'desc');
      return key;
    });
  }, []);

  const entities = useMemo(() => {
    const rows = [...(data?.entities ?? [])];
    const dir = sortDir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'name': cmp = a.name.localeCompare(b.name); break;
        case 'revenue': cmp = a.revenueCents - b.revenueCents; break;
        case 'grossProfit': cmp = a.grossProfitCents - b.grossProfitCents; break;
        case 'opex': cmp = a.opexCents - b.opexCents; break;
        case 'netIncome': cmp = a.netIncomeCents - b.netIncomeCents; break;
        case 'netMargin':
          cmp = (a.netMarginPct ?? -Infinity) - (b.netMarginPct ?? -Infinity); break;
      }
      return cmp * dir;
    });
    return rows;
  }, [data?.entities, sortKey, sortDir]);

  const rollup = data?.rollup;
  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1;

  // Focused-entity view: the active company's own row + where it ranks by net
  // income among entities that actually posted activity this period.
  const focusActive = focusMode === 'focused' && isSpecificCompany(activeCompanyId);
  const focusedEntity = useMemo(
    () => (focusActive ? (data?.entities ?? []).find((e) => e.locationId === activeCompanyId) ?? null : null),
    [focusActive, data?.entities, activeCompanyId],
  );
  const focusedRank = useMemo(() => {
    if (!focusedEntity || !focusedEntity.hasActivity) return 0;
    const ranked = (data?.entities ?? [])
      .filter((e) => e.hasActivity)
      .sort((a, b) => b.netIncomeCents - a.netIncomeCents);
    return ranked.findIndex((e) => e.locationId === focusedEntity.locationId) + 1;
  }, [focusedEntity, data?.entities]);

  return (
    <div className="space-y-5">
      {/* Period selector + focus toggle + refresh */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-surface-900 p-1">
            <button
              onClick={() => stepMonth(-1)}
              className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
              aria-label="Previous month"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="min-w-[9.5rem] px-2 text-center text-sm font-medium text-white">
              {data?.period.label ?? new Date(year, month - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' })}
            </span>
            <button
              onClick={() => stepMonth(1)}
              disabled={isCurrentMonth}
              className="rounded-md p-1.5 text-slate-400 enabled:hover:bg-slate-800 enabled:hover:text-white disabled:opacity-30"
              aria-label="Next month"
            >
              <ChevronRight size={16} />
            </button>
          </div>

          {/* Focus toggle — only when a specific company is active in the header. */}
          {isSpecificCompany(activeCompanyId) && activeCompany && (
            <div className="inline-flex items-center rounded-lg border border-slate-800 bg-surface-900 p-1 text-xs" role="group" aria-label="Scope">
              <button
                onClick={() => pickFocus('focused')}
                className={clsx(
                  'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition-colors',
                  focusMode === 'focused' ? 'bg-brand-500 text-white' : 'text-slate-400 hover:text-slate-200',
                )}
              >
                <Building2 size={13} />
                <span className="max-w-[10rem] truncate">{activeCompany.name}</span>
              </button>
              <button
                onClick={() => pickFocus('all')}
                className={clsx(
                  'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition-colors',
                  focusMode === 'all' ? 'bg-brand-500 text-white' : 'text-slate-400 hover:text-slate-200',
                )}
              >
                <Layers size={13} />
                All entities
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          {data && <span className="text-[11px] text-slate-500">Updated {relativeTime(data.generatedAt)}</span>}
          <button
            onClick={() => { setRefreshKey((k) => k + 1); refetch(); }}
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
          <button
            onClick={() => { setRefreshKey((k) => k + 1); refetch(); }}
            className="mt-4 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
          >
            Try again
          </button>
        </div>
      ) : !rollup || rollup.entityCount === 0 ? (
        <div className="card p-12 text-center">
          <Building2 className="mx-auto mb-3 h-8 w-8 text-slate-600" />
          <p className="text-sm font-medium text-slate-300">No entities to report on</p>
          <p className="mt-1 text-xs text-slate-500">
            No active companies were found. Create entities and post activity to light up the board.
          </p>
        </div>
      ) : focusActive && focusedEntity && !focusedEntity.hasActivity ? (
        // Fresh / sandbox company: entity exists but posted nothing this period.
        <div className="card p-12 text-center">
          <Building2 className="mx-auto mb-3 h-8 w-8 text-slate-600" />
          <p className="text-sm font-medium text-slate-300">
            No posted activity for {focusedEntity.name}
          </p>
          <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
            This company has no revenue or expenses posted in{' '}
            {data?.period.label ?? 'this period'}. Post journal entries, or switch to
            the full portfolio to see how the other entities are performing.
          </p>
          <button
            onClick={() => pickFocus('all')}
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 hover:text-white"
          >
            <Layers size={13} /> View all entities
          </button>
        </div>
      ) : (
        <>
          {focusActive && focusedEntity ? (
            // ── Focused on the active company: its own P&L + portfolio rank ──
            <>
              <p className="flex items-center gap-1.5 text-xs text-slate-500">
                <Building2 size={13} className="text-brand-400" />
                Showing <span className="font-medium text-slate-300">{focusedEntity.name}</span> — its
                standalone P&amp;L and where it ranks in the portfolio.
              </p>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <StatTile
                  label="Revenue"
                  value={formatMoney(focusedEntity.revenueCents, { compact: true })}
                  hint={`${fmtPct(focusedEntity.grossMarginPct)} gross margin`}
                  icon={Wallet}
                />
                <StatTile
                  label="Gross profit"
                  value={formatMoney(focusedEntity.grossProfitCents, { compact: true })}
                  hint={`${fmtPct(focusedEntity.grossMarginPct)} gross margin`}
                  icon={TrendingUp}
                  tone={focusedEntity.grossProfitCents >= 0 ? 'good' : 'danger'}
                />
                <StatTile
                  label="Net income"
                  value={formatMoney(focusedEntity.netIncomeCents, { compact: true })}
                  hint={`${fmtPct(focusedEntity.netMarginPct)} net margin`}
                  icon={focusedEntity.netIncomeCents >= 0 ? TrendingUp : TrendingDown}
                  tone={focusedEntity.netIncomeCents >= 0 ? 'good' : 'danger'}
                />
                <StatTile
                  label="Portfolio rank"
                  value={focusedRank > 0 ? `#${focusedRank} of ${rollup.activeCount}` : '—'}
                  hint="by net income"
                  icon={Building2}
                  tone={
                    focusedRank > 0 && focusedRank <= Math.ceil(rollup.activeCount / 2) ? 'good' : 'default'
                  }
                />
              </div>
            </>
          ) : (
            // ── Consolidated roll-up (All entities) ──
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatTile
                label="Consolidated revenue"
                value={formatMoney(rollup.revenueCents, { compact: true })}
                hint={`${rollup.activeCount} of ${rollup.entityCount} entities active`}
                icon={Wallet}
              />
              <StatTile
                label="Gross profit"
                value={formatMoney(rollup.grossProfitCents, { compact: true })}
                hint={`${fmtPct(rollup.grossMarginPct)} gross margin`}
                icon={TrendingUp}
                tone={rollup.grossProfitCents >= 0 ? 'good' : 'danger'}
              />
              <StatTile
                label="Net income"
                value={formatMoney(rollup.netIncomeCents, { compact: true })}
                hint={`${fmtPct(rollup.netMarginPct)} net margin (weighted)`}
                icon={rollup.netIncomeCents >= 0 ? TrendingUp : TrendingDown}
                tone={rollup.netIncomeCents >= 0 ? 'good' : 'danger'}
              />
              <StatTile
                label="Profitable entities"
                value={`${rollup.profitableCount}/${rollup.activeCount}`}
                hint={rollup.unprofitableCount > 0 ? `${rollup.unprofitableCount} losing money` : 'none in the red'}
                icon={Building2}
                tone={rollup.unprofitableCount > 0 ? 'warn' : 'good'}
              />
            </div>
          )}

          {/* Net-income visual — the focused entity's bar is emphasized. */}
          <NetIncomeChart
            entities={data?.entities ?? []}
            highlightId={focusActive && focusedEntity ? focusedEntity.locationId : null}
          />

          {/* Per-entity P&L table */}
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-800/60 text-left text-[11px] text-slate-500">
                    <th className="px-4 py-2.5 font-medium">
                      <SortHeader label="Entity" active={sortKey === 'name'} dir={sortDir} onClick={() => setSort('name')} />
                    </th>
                    <th className="px-3 py-2.5 text-right font-medium">
                      <SortHeader label="Revenue" active={sortKey === 'revenue'} dir={sortDir} onClick={() => setSort('revenue')} align="right" />
                    </th>
                    <th className="px-3 py-2.5 text-right font-medium">COGS</th>
                    <th className="px-3 py-2.5 text-right font-medium">
                      <SortHeader label="Gross profit" active={sortKey === 'grossProfit'} dir={sortDir} onClick={() => setSort('grossProfit')} align="right" />
                    </th>
                    <th className="px-3 py-2.5 text-right font-medium">GM%</th>
                    <th className="px-3 py-2.5 text-right font-medium">
                      <SortHeader label="OpEx" active={sortKey === 'opex'} dir={sortDir} onClick={() => setSort('opex')} align="right" />
                    </th>
                    <th className="px-3 py-2.5 text-right font-medium">
                      <SortHeader label="Net income" active={sortKey === 'netIncome'} dir={sortDir} onClick={() => setSort('netIncome')} align="right" />
                    </th>
                    <th className="px-3 py-2.5 text-right font-medium">
                      <SortHeader label="NM%" active={sortKey === 'netMargin'} dir={sortDir} onClick={() => setSort('netMargin')} align="right" />
                    </th>
                    <th className="px-4 py-2.5 text-right font-medium" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/40">
                  {entities.map((e) => (
                    <tr
                      key={e.locationId}
                      className={clsx(
                        'text-slate-300 transition-colors hover:bg-slate-800/30',
                        !e.hasActivity && 'opacity-55',
                        focusActive && e.locationId === activeCompanyId && 'bg-brand-500/[0.07] ring-1 ring-inset ring-brand-500/30',
                      )}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-slate-700/70 font-mono text-[9px] text-slate-300">
                            {e.shortCode || '—'}
                          </span>
                          <span className="font-medium text-slate-100">{e.name}</span>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums text-slate-300">{formatMoney(e.revenueCents)}</td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums text-slate-400">{formatMoney(e.cogsCents)}</td>
                      <td className={clsx('px-3 py-3 text-right font-mono tabular-nums', moneyTone(e.grossProfitCents))}>{formatMoney(e.grossProfitCents)}</td>
                      <td className={clsx('px-3 py-3 text-right font-mono tabular-nums', marginTone(e.grossMarginPct))}>{fmtPct(e.grossMarginPct)}</td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums text-slate-400">{formatMoney(e.opexCents)}</td>
                      <td className={clsx('px-3 py-3 text-right font-mono tabular-nums font-semibold', moneyTone(e.netIncomeCents))}>{formatMoney(e.netIncomeCents)}</td>
                      <td className={clsx('px-3 py-3 text-right font-mono tabular-nums', marginTone(e.netMarginPct))}>{fmtPct(e.netMarginPct)}</td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/reports?location_id=${e.locationId}&start_date=${startDate}&end_date=${endDate}`}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-800 bg-surface-900 px-2.5 py-1 text-[11px] text-slate-300 hover:border-emerald-500/40 hover:text-white"
                        >
                          Statements
                          <ChevronRight size={11} />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
                {/* Consolidated total row */}
                <tfoot>
                  <tr className="border-t border-slate-700/60 bg-surface-950/50 text-slate-200">
                    <td className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-400">Consolidated</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">{formatMoney(rollup.revenueCents)}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums text-slate-400">{formatMoney(rollup.cogsCents)}</td>
                    <td className={clsx('px-3 py-3 text-right font-mono tabular-nums', moneyTone(rollup.grossProfitCents))}>{formatMoney(rollup.grossProfitCents)}</td>
                    <td className={clsx('px-3 py-3 text-right font-mono tabular-nums', marginTone(rollup.grossMarginPct))}>{fmtPct(rollup.grossMarginPct)}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums text-slate-400">{formatMoney(rollup.opexCents)}</td>
                    <td className={clsx('px-3 py-3 text-right font-mono tabular-nums font-semibold', moneyTone(rollup.netIncomeCents))}>{formatMoney(rollup.netIncomeCents)}</td>
                    <td className={clsx('px-3 py-3 text-right font-mono tabular-nums', marginTone(rollup.netMarginPct))}>{fmtPct(rollup.netMarginPct)}</td>
                    <td className="px-4 py-3" />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          <p className="text-[11px] leading-relaxed text-slate-600">
            Each row is that entity&apos;s income statement for the selected month, resolved by account
            type (Revenue − COGS = Gross Profit − OpEx − Other = Net Income), read live from posted GL
            entries. The Consolidated total is a straight sum; it does not apply intercompany eliminations —
            the Consolidated statement in Reports does. &ldquo;Statements&rdquo; opens that entity&apos;s full reports.
          </p>
        </>
      )}
    </div>
  );
}
