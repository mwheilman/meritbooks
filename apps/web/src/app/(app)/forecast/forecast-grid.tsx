'use client';

import { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { useQuery } from '@/hooks';
import {
  Loader2, AlertCircle, TrendingUp, AlertTriangle, ArrowDownRight,
  ArrowUpRight, Info, X, ChevronRight,
} from 'lucide-react';

interface ForecastItem {
  id: string;
  dueDate: string;
  amountCents: number;
  label: string;
  party: string;
  status: string;
  overdue: boolean;
}

interface ForecastWeek {
  index: number;
  weekNumber: number;
  startDate: string;
  endDate: string;
  openingCents: number;
  inflowsCents: number;
  outflowsCents: number;
  netCents: number;
  closingCents: number;
  confidence: number;
  inflowItems: ForecastItem[];
  outflowItems: ForecastItem[];
  inflowItemCount: number;
  outflowItemCount: number;
}

interface ForecastResponse {
  anchorDate: string;
  startingCashCents: number;
  endingCashCents: number;
  weeks: ForecastWeek[];
  lowWaterMarkCents: number;
  lowWaterWeekIndex: number;
  negativeWeekCount: number;
  totalInflowsCents: number;
  totalOutflowsCents: number;
  beyondHorizonInflowsCents: number;
  beyondHorizonOutflowsCents: number;
  meta: {
    locationId: string | null;
    consolidated: boolean;
    bankAccountCount: number;
    openInvoiceCount: number;
    openBillCount: number;
    generatedAt: string;
  };
}

interface LocationOption {
  id: string;
  name: string;
  short_code: string;
}

function fmtWeekLabel(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// ── Inline SVG chart: net bars + projected ending-balance line ───────────────
function ForecastChart({ weeks }: { weeks: ForecastWeek[] }) {
  const W = 760;
  const H = 240;
  const padL = 8;
  const padR = 8;
  const padT = 16;
  const padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const n = weeks.length || 1;
  const slot = innerW / n;

  const closings = weeks.map((w) => w.closingCents);
  const nets = weeks.map((w) => w.netCents);
  const values = [...closings, ...nets, 0];
  const max = values.length ? Math.max(...values) : 0;
  const min = values.length ? Math.min(...values) : 0;
  const range = max - min || 1;
  const y = (v: number) => padT + innerH - ((v - min) / range) * innerH;
  const zeroY = y(0);

  const linePts = weeks
    .map((w, i) => `${padL + slot * i + slot / 2},${y(w.closingCents)}`)
    .join(' ');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Projected weekly ending balance">
      {/* zero baseline */}
      <line x1={padL} y1={zeroY} x2={W - padR} y2={zeroY} stroke="#2C362F" strokeWidth={1} strokeDasharray="3 3" />
      {/* net bars */}
      {weeks.map((w, i) => {
        const barX = padL + slot * i + slot * 0.28;
        const barW = slot * 0.44;
        const top = w.netCents >= 0 ? y(w.netCents) : zeroY;
        const h = Math.max(1, Math.abs(zeroY - y(w.netCents)));
        return (
          <rect
            key={`bar-${i}`}
            x={barX}
            y={top}
            width={barW}
            height={h}
            rx={1.5}
            fill={w.netCents >= 0 ? '#10b981' : '#ef4444'}
            opacity={0.35}
          />
        );
      })}
      {/* ending-balance line */}
      {weeks.length > 0 && <polyline points={linePts} fill="none" stroke="#10b981" strokeWidth={2} />}
      {weeks.map((w, i) => (
        <circle
          key={`pt-${i}`}
          cx={padL + slot * i + slot / 2}
          cy={y(w.closingCents)}
          r={2.5}
          fill={w.closingCents < 0 ? '#ef4444' : '#10b981'}
        />
      ))}
      {/* x labels */}
      {weeks.map((w, i) => (
        <text
          key={`lbl-${i}`}
          x={padL + slot * i + slot / 2}
          y={H - 10}
          textAnchor="middle"
          fontSize={9}
          fill="#7E8983"
          fontFamily="var(--font-mono, monospace)"
        >
          W{w.weekNumber}
        </text>
      ))}
    </svg>
  );
}

// ── Drill-down panel for a single week ───────────────────────────────────────
function WeekDetail({ week, onClose }: { week: ForecastWeek; onClose: () => void }) {
  const Section = ({
    title, items, count, tone, icon,
  }: {
    title: string; items: ForecastItem[]; count: number; tone: 'in' | 'out'; icon: React.ReactNode;
  }) => (
    <div className="flex-1 min-w-[240px]">
      <div className="flex items-center gap-1.5 mb-2">
        {icon}
        <span className="text-xs font-semibold text-slate-300">{title}</span>
        <span className="text-2xs text-slate-500">({count})</span>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-slate-600 py-2">Nothing scheduled this week.</p>
      ) : (
        <div className="space-y-1">
          {items.map((it) => (
            <div key={it.id} className="flex items-center justify-between gap-3 py-1 border-b border-slate-800/40 last:border-0">
              <div className="min-w-0">
                <p className="text-xs text-slate-300 truncate">{it.party}</p>
                <p className="text-[10px] text-slate-600 font-mono">
                  {it.label} · due {fmtWeekLabel(it.dueDate)}
                  {it.overdue && <span className="ml-1 text-amber-500">overdue</span>}
                </p>
              </div>
              <span className={clsx('text-xs font-mono shrink-0', tone === 'in' ? 'text-emerald-400' : 'text-red-400')}>
                {tone === 'in' ? '' : '('}{formatMoney(it.amountCents)}{tone === 'in' ? '' : ')'}
              </span>
            </div>
          ))}
          {count > items.length && (
            <p className="text-[10px] text-slate-600 pt-1">+ {count - items.length} more…</p>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="card p-4 border border-emerald-500/20">
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-sm font-semibold text-white">
            Week {week.weekNumber} · {fmtWeekLabel(week.startDate)} – {fmtWeekLabel(week.endDate)}
          </p>
          <p className="text-xs text-slate-500 font-mono">
            Opening {formatMoney(week.openingCents)} → Closing{' '}
            <span className={week.closingCents < 0 ? 'text-red-400' : 'text-emerald-400'}>
              {formatMoney(week.closingCents)}
            </span>
          </p>
        </div>
        <button onClick={onClose} className="p-1 rounded hover:bg-slate-800 text-slate-500 hover:text-white" aria-label="Close detail">
          <X size={16} />
        </button>
      </div>
      <div className="flex flex-wrap gap-6">
        <Section title="Expected inflows (AR)" items={week.inflowItems} count={week.inflowItemCount} tone="in" icon={<ArrowUpRight size={13} className="text-emerald-400" />} />
        <Section title="Expected outflows (AP)" items={week.outflowItems} count={week.outflowItemCount} tone="out" icon={<ArrowDownRight size={13} className="text-red-400" />} />
      </div>
    </div>
  );
}

export function ForecastGrid() {
  const [locationId, setLocationId] = useState('');
  const [selectedWeek, setSelectedWeek] = useState<number | null>(null);

  const { data: locData } = useQuery<LocationOption[]>('/api/locations');
  const locations = locData ?? [];

  const params = useMemo(() => (locationId ? { location_id: locationId } : undefined), [locationId]);
  const { data, isLoading, error } = useQuery<ForecastResponse>('/api/forecast', params);

  const weeks = data?.weeks ?? [];
  const activeWeek = selectedWeek !== null ? weeks.find((w) => w.index === selectedWeek) ?? null : null;

  const Selector = (
    <div className="flex items-center gap-2">
      <select
        value={locationId}
        onChange={(e) => { setLocationId(e.target.value); setSelectedWeek(null); }}
        className="px-3 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white focus:border-emerald-500 focus:outline-none"
      >
        <option value="">All companies (consolidated)</option>
        {locations.map((l) => (
          <option key={l.id} value={l.id}>{l.name}</option>
        ))}
      </select>
    </div>
  );

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">{Selector}</div>
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 text-emerald-400 animate-spin" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">{Selector}</div>
        <div className="card p-10 text-center">
          <AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      </div>
    );
  }

  const starting = data?.startingCashCents ?? 0;
  const ending = data?.endingCashCents ?? 0;
  const low = data?.lowWaterMarkCents ?? 0;
  const lowIdx = data?.lowWaterWeekIndex ?? -1;
  const negCount = data?.negativeWeekCount ?? 0;
  const totalIn = data?.totalInflowsCents ?? 0;
  const totalOut = data?.totalOutflowsCents ?? 0;
  const meta = data?.meta;

  const hasAnyData =
    starting !== 0 || (meta?.openInvoiceCount ?? 0) > 0 || (meta?.openBillCount ?? 0) > 0;

  return (
    <div className="space-y-5">
      {/* Controls */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        {Selector}
        {meta && (
          <p className="text-xs text-slate-500">
            {meta.consolidated ? 'Consolidated' : 'Single company'} · {meta.bankAccountCount} bank acct
            {meta.bankAccountCount === 1 ? '' : 's'} · {meta.openInvoiceCount} open AR · {meta.openBillCount} open AP
          </p>
        )}
      </div>

      {/* Empty-data guidance (table still renders with zeros) */}
      {!hasAnyData && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-lg bg-indigo-500/5 border border-indigo-500/10">
          <TrendingUp size={16} className="text-indigo-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm text-indigo-300">No cash activity to project yet</p>
            <p className="text-xs text-slate-500 mt-0.5">
              The 13-week forecast draws starting cash from connected bank accounts, inflows from open
              invoices (by due date), and outflows from open bills (by due date). Connect a bank and
              enter AR/AP to populate the projection.
            </p>
          </div>
        </div>
      )}

      {/* Low-water-mark warning */}
      {negCount > 0 && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-lg bg-red-500/5 border border-red-500/20">
          <AlertTriangle size={16} className="text-red-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm text-red-300">
              Projected cash goes negative in {negCount} week{negCount === 1 ? '' : 's'}
            </p>
            <p className="text-xs text-slate-500 mt-0.5">
              Low-water mark {formatMoney(low)}
              {lowIdx >= 0 && weeks[lowIdx] ? ` in week ${weeks[lowIdx].weekNumber} (${fmtWeekLabel(weeks[lowIdx].startDate)})` : ''}.
              Consider accelerating collections or delaying discretionary payments.
            </p>
          </div>
        </div>
      )}

      {/* Summary metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="card p-4">
          <span className="text-xs text-slate-500 uppercase tracking-wider">Starting cash</span>
          <p className="text-xl font-mono font-semibold text-white mt-1">{formatMoney(starting)}</p>
        </div>
        <div className="card p-4">
          <span className="text-xs text-slate-500 uppercase tracking-wider">Projected (13 wk)</span>
          <p className={clsx('text-xl font-mono font-semibold mt-1', ending < 0 ? 'text-red-400' : 'text-white')}>
            {formatMoney(ending)}
          </p>
        </div>
        <div className="card p-4">
          <span className="text-xs text-slate-500 uppercase tracking-wider flex items-center gap-1">
            <ArrowUpRight size={12} className="text-emerald-400" /> Inflows
          </span>
          <p className="text-xl font-mono font-semibold text-emerald-400 mt-1">{formatMoney(totalIn)}</p>
        </div>
        <div className="card p-4">
          <span className="text-xs text-slate-500 uppercase tracking-wider flex items-center gap-1">
            <ArrowDownRight size={12} className="text-red-400" /> Outflows
          </span>
          <p className="text-xl font-mono font-semibold text-red-400 mt-1">{formatMoney(totalOut)}</p>
        </div>
      </div>

      {/* Chart */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Projected ending balance</p>
          <div className="flex items-center gap-3 text-[10px] text-slate-500">
            <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-emerald-500 inline-block" /> Ending balance</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-emerald-500/40 inline-block rounded-sm" /> Net / week</span>
          </div>
        </div>
        <ForecastChart weeks={weeks} />
      </div>

      {/* 13-week table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500 sticky left-0 bg-slate-950 z-10 min-w-[140px]">
                  Week
                </th>
                {weeks.map((w) => {
                  const isLow = w.index === lowIdx;
                  return (
                    <th
                      key={w.index}
                      onClick={() => setSelectedWeek(selectedWeek === w.index ? null : w.index)}
                      className={clsx(
                        'px-3 py-2.5 text-center min-w-[104px] cursor-pointer hover:bg-slate-800/40 transition-colors',
                        selectedWeek === w.index && 'bg-emerald-500/10',
                        isLow && 'bg-amber-500/5'
                      )}
                      title="Click for weekly detail"
                    >
                      <p className="text-2xs font-semibold uppercase text-slate-400">W{w.weekNumber}</p>
                      <p className="text-[10px] text-slate-600 font-mono">{fmtWeekLabel(w.startDate)}</p>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {/* Opening */}
              <Row label="Opening balance" bg>
                {weeks.map((w) => (
                  <Cell key={w.index} className="text-slate-400">{formatMoney(w.openingCents)}</Cell>
                ))}
              </Row>
              {/* Inflows */}
              <Row label="Inflows (AR)" indent labelClass="text-emerald-400">
                {weeks.map((w) => (
                  <Cell key={w.index} className={w.inflowsCents > 0 ? 'text-emerald-400' : 'text-slate-700'}>
                    {w.inflowsCents > 0 ? formatMoney(w.inflowsCents) : '—'}
                  </Cell>
                ))}
              </Row>
              {/* Outflows */}
              <Row label="Outflows (AP)" indent labelClass="text-red-400">
                {weeks.map((w) => (
                  <Cell key={w.index} className={w.outflowsCents > 0 ? 'text-red-400' : 'text-slate-700'}>
                    {w.outflowsCents > 0 ? `(${formatMoney(w.outflowsCents)})` : '—'}
                  </Cell>
                ))}
              </Row>
              {/* Net */}
              <Row label="Net cash flow" indent topBorder>
                {weeks.map((w) => (
                  <Cell
                    key={w.index}
                    className={clsx('font-medium', w.netCents > 0 ? 'text-emerald-400' : w.netCents < 0 ? 'text-red-400' : 'text-slate-700')}
                  >
                    {w.netCents !== 0 ? formatMoney(w.netCents, { showSign: true }) : '—'}
                  </Cell>
                ))}
              </Row>
              {/* Closing */}
              <tr className="bg-slate-800/20 border-t border-slate-700">
                <td className="px-4 py-2.5 text-xs font-semibold text-white sticky left-0 bg-slate-800/20 z-10">
                  Closing balance
                </td>
                {weeks.map((w) => (
                  <td
                    key={w.index}
                    className={clsx(
                      'px-3 py-2.5 text-center text-xs font-mono font-semibold',
                      w.closingCents < 0 ? 'text-red-400 bg-red-500/10' : w.index === lowIdx ? 'text-amber-300 bg-amber-500/5' : 'text-white'
                    )}
                  >
                    {formatMoney(w.closingCents)}
                  </td>
                ))}
              </tr>
              {/* Confidence */}
              <tr>
                <td className="px-4 py-2 text-[10px] text-slate-600 sticky left-0 bg-slate-950 z-10">Confidence band</td>
                {weeks.map((w) => (
                  <td key={w.index} className="px-3 py-2 text-center">
                    <span
                      className={clsx(
                        'text-[10px] font-mono',
                        w.confidence >= 90 ? 'text-emerald-500' : w.confidence >= 75 ? 'text-amber-500' : 'text-orange-500'
                      )}
                    >
                      {w.confidence}%
                    </span>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Drill-down */}
      {activeWeek ? (
        <WeekDetail week={activeWeek} onClose={() => setSelectedWeek(null)} />
      ) : (
        weeks.length > 0 && (
          <p className="flex items-center gap-1.5 text-xs text-slate-600">
            <ChevronRight size={12} /> Click any week column to see the invoices and bills driving it.
          </p>
        )
      )}

      {/* Methodology note */}
      <div className="flex items-start gap-2 text-[11px] text-slate-600">
        <Info size={12} className="mt-0.5 shrink-0" />
        <p>
          Direct method: starting cash from active checking/savings balances, inflows from open invoice
          balances and outflows from open bill balances, each timed to its due date (past-due amounts land
          in week 1). Payroll, taxes, and recurring transfers not yet modeled. Confidence bands are
          directional, not statistical.
          {data && (data.beyondHorizonInflowsCents > 0 || data.beyondHorizonOutflowsCents > 0) ? (
            <> {' '}Beyond 13 weeks: {formatMoney(data.beyondHorizonInflowsCents)} AR / {formatMoney(data.beyondHorizonOutflowsCents)} AP (excluded).</>
          ) : null}
        </p>
      </div>
    </div>
  );
}

// ── Small table primitives ───────────────────────────────────────────────────
function Row({
  label, children, bg, indent, topBorder, labelClass,
}: {
  label: string; children: React.ReactNode; bg?: boolean; indent?: boolean; topBorder?: boolean; labelClass?: string;
}) {
  return (
    <tr className={clsx(bg && 'bg-slate-800/20', topBorder && 'border-t border-slate-800/50', 'hover:bg-slate-800/10')}>
      <td
        className={clsx(
          'px-4 py-2 text-xs sticky left-0 z-10',
          bg ? 'bg-slate-800/20 font-medium text-slate-300' : 'bg-slate-950',
          indent && 'pl-6',
          labelClass ?? 'text-slate-300'
        )}
      >
        {label}
      </td>
      {children}
    </tr>
  );
}

function Cell({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={clsx('px-3 py-2 text-center text-xs font-mono', className)}>{children}</td>;
}
