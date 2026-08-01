'use client';

import { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { useQuery } from '@/hooks';
import {
  Loader2, AlertCircle, CreditCard, Landmark, Percent, DollarSign, Receipt,
  ArrowUpDown, Info, Cpu, Building2,
} from 'lucide-react';

// ── Types (mirror /api/platform/fee-revenue) ─────────────────────────────────
type Rail = 'CARD' | 'ACH';

interface Totals {
  feeCents: number;
  grossCents: number;
  paymentCount: number;
  takeRateBps: number;
}
interface TenantBreakdown {
  orgId: string;
  orgName: string;
  feeCents: number;
  grossCents: number;
  paymentCount: number;
  takeRateBps: number;
}
interface RailBreakdown {
  rail: Rail;
  feeCents: number;
  grossCents: number;
  paymentCount: number;
  takeRateBps: number;
}
interface TrendPoint {
  month: string;
  feeCents: number;
  grossCents: number;
  paymentCount: number;
}
interface FeeRevenueResponse {
  totals: Totals;
  byTenant: TenantBreakdown[];
  byRail: RailBreakdown[];
  trend: TrendPoint[];
  meta: {
    from: string | null;
    to: string | null;
    tenantCount: number;
    feeSource: string;
    feePersisted: boolean;
    generatedAt: string;
  };
}

// ── Period presets ───────────────────────────────────────────────────────────
type PresetKey = 'mtd' | 'last_month' | 'qtd' | 'ytd' | 'ttm' | 'all';
const PRESETS: { key: PresetKey; label: string }[] = [
  { key: 'mtd', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'qtd', label: 'Quarter to date' },
  { key: 'ytd', label: 'Year to date' },
  { key: 'ttm', label: 'Last 12 months' },
  { key: 'all', label: 'All time' },
];

const iso = (d: Date) => d.toISOString().slice(0, 10);

function rangeFor(preset: PresetKey): { from: string | null; to: string | null } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const today = iso(now);
  switch (preset) {
    case 'mtd':
      return { from: iso(new Date(Date.UTC(y, m, 1))), to: today };
    case 'last_month':
      return { from: iso(new Date(Date.UTC(y, m - 1, 1))), to: iso(new Date(Date.UTC(y, m, 0))) };
    case 'qtd': {
      const qStartMonth = Math.floor(m / 3) * 3;
      return { from: iso(new Date(Date.UTC(y, qStartMonth, 1))), to: today };
    }
    case 'ytd':
      return { from: iso(new Date(Date.UTC(y, 0, 1))), to: today };
    case 'ttm':
      return { from: iso(new Date(Date.UTC(y - 1, m, now.getUTCDate() + 1))), to: today };
    case 'all':
    default:
      return { from: null, to: null };
  }
}

const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;
const monthLabel = (ym: string) => {
  const [yy, mm] = ym.split('-').map(Number);
  return new Date(Date.UTC(yy, mm - 1, 1)).toLocaleDateString('en-US', {
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  });
};

// ── Sort state for the tenant table ──────────────────────────────────────────
type SortKey = 'orgName' | 'paymentCount' | 'grossCents' | 'feeCents' | 'takeRateBps';

export function FeeRevenueReport() {
  const [preset, setPreset] = useState<PresetKey>('ttm');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'feeCents',
    dir: 'desc',
  });

  const range = useMemo(() => rangeFor(preset), [preset]);
  const params = useMemo(() => {
    const p: Record<string, string> = {};
    if (range.from) p.from = range.from;
    if (range.to) p.to = range.to;
    return p;
  }, [range]);

  const { data, isLoading, error } = useQuery<FeeRevenueResponse>('/api/platform/fee-revenue', params);

  const Selector = (
    <div className="flex items-center gap-2">
      <label className="text-2xs uppercase tracking-wider text-slate-500">Period</label>
      <select
        value={preset}
        onChange={(e) => setPreset(e.target.value as PresetKey)}
        className="px-3 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white focus:border-indigo-500 focus:outline-none"
      >
        {PRESETS.map((p) => (
          <option key={p.key} value={p.key}>
            {p.label}
          </option>
        ))}
      </select>
    </div>
  );

  // ── Loading ────────────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">{Selector}</div>
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 text-indigo-400 animate-spin" />
        </div>
      </div>
    );
  }

  // ── Error ────────────────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">{Selector}</div>
        <div className="card p-10 text-center">
          <AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" />
          <p className="text-sm text-red-400">{error}</p>
          <p className="text-xs text-slate-500 mt-1">
            The fee-revenue report could not be loaded. This view is restricted to platform staff.
          </p>
        </div>
      </div>
    );
  }

  const totals = data?.totals ?? { feeCents: 0, grossCents: 0, paymentCount: 0, takeRateBps: 0 };
  const byRail = data?.byRail ?? [];
  const byTenant = data?.byTenant ?? [];
  const trend = data?.trend ?? [];
  const hasData = totals.paymentCount > 0;

  const sortedTenants = [...byTenant].sort((a, b) => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    if (sort.key === 'orgName') return a.orgName.localeCompare(b.orgName) * dir;
    return (a[sort.key] - b[sort.key]) * dir;
  });

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));

  const card = byRail.find((r) => r.rail === 'CARD');
  const ach = byRail.find((r) => r.rail === 'ACH');

  return (
    <div className="space-y-5">
      {/* Controls */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        {Selector}
        <div className="flex items-center gap-1.5 text-2xs text-indigo-300/80">
          <Cpu size={12} className="text-indigo-400" />
          Platform-plane analytics · cross-tenant
        </div>
      </div>

      {/* Summary metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="card p-5 border border-indigo-500/20 bg-indigo-500/[0.04]">
          <div className="flex items-start justify-between">
            <p className="text-sm text-slate-400">Fee revenue earned</p>
            <div className="h-8 w-8 rounded-lg bg-indigo-500/15 flex items-center justify-center">
              <DollarSign size={16} className="text-indigo-300" />
            </div>
          </div>
          <p className="mt-2 text-2xl font-semibold text-white tracking-tight font-mono tabular-nums">
            {formatMoney(totals.feeCents)}
          </p>
          <p className="mt-1 text-2xs text-slate-500">Application fees the platform earned</p>
        </div>

        <div className="card p-5">
          <div className="flex items-start justify-between">
            <p className="text-sm text-slate-400">Gross processed</p>
            <div className="h-8 w-8 rounded-lg bg-emerald-500/10 flex items-center justify-center">
              <Receipt size={16} className="text-emerald-400" />
            </div>
          </div>
          <p className="mt-2 text-2xl font-semibold text-white tracking-tight font-mono tabular-nums">
            {formatMoney(totals.grossCents)}
          </p>
          <p className="mt-1 text-2xs text-slate-500">Payment volume run through the rails</p>
        </div>

        <div className="card p-5">
          <div className="flex items-start justify-between">
            <p className="text-sm text-slate-400">Payments</p>
            <div className="h-8 w-8 rounded-lg bg-slate-700/40 flex items-center justify-center">
              <CreditCard size={16} className="text-slate-300" />
            </div>
          </div>
          <p className="mt-2 text-2xl font-semibold text-white tracking-tight font-mono tabular-nums">
            {totals.paymentCount.toLocaleString()}
          </p>
          <p className="mt-1 text-2xs text-slate-500">Card + ACH collections</p>
        </div>

        <div className="card p-5">
          <div className="flex items-start justify-between">
            <p className="text-sm text-slate-400">Effective take-rate</p>
            <div className="h-8 w-8 rounded-lg bg-indigo-500/10 flex items-center justify-center">
              <Percent size={16} className="text-indigo-300" />
            </div>
          </div>
          <p className="mt-2 text-2xl font-semibold text-white tracking-tight font-mono tabular-nums">
            {pct(totals.takeRateBps)}
          </p>
          <p className="mt-1 text-2xs text-slate-500">Fee ÷ gross across all tenants</p>
        </div>
      </div>

      {/* Empty state */}
      {!hasData ? (
        <div className="card p-12 text-center">
          <div className="h-12 w-12 rounded-xl bg-indigo-500/10 flex items-center justify-center mx-auto mb-4">
            <DollarSign size={24} className="text-indigo-300" />
          </div>
          <h3 className="text-sm font-medium text-slate-200 mb-1">No fee revenue in this period</h3>
          <p className="text-sm text-slate-500 max-w-md mx-auto">
            The platform earns an application fee on every card and ACH payment collected through
            MeritBooks. Once tenants collect online payments in this window, the revenue, tenant
            breakdown, and trend appear here.
          </p>
        </div>
      ) : (
        <>
          {/* By rail */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <RailCard rail="CARD" icon={CreditCard} data={card} totalFee={totals.feeCents} />
            <RailCard rail="ACH" icon={Landmark} data={ach} totalFee={totals.feeCents} />
          </div>

          {/* Trend */}
          <div className="card p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Fee revenue by month
              </p>
              <div className="flex items-center gap-3 text-[10px] text-slate-500">
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 bg-indigo-500 inline-block rounded-sm" /> Fee earned
                </span>
              </div>
            </div>
            <TrendChart trend={trend} />
          </div>

          {/* By tenant */}
          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800 flex items-center gap-2">
              <Building2 size={14} className="text-slate-400" />
              <p className="text-xs font-semibold text-slate-300">
                By tenant
                <span className="text-slate-600 font-normal"> · {byTenant.length} org{byTenant.length === 1 ? '' : 's'}</span>
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-800">
                    <Th label="Tenant" sortKey="orgName" sort={sort} onSort={toggleSort} align="left" />
                    <Th label="Payments" sortKey="paymentCount" sort={sort} onSort={toggleSort} />
                    <Th label="Gross processed" sortKey="grossCents" sort={sort} onSort={toggleSort} />
                    <Th label="Fee revenue" sortKey="feeCents" sort={sort} onSort={toggleSort} />
                    <Th label="Take-rate" sortKey="takeRateBps" sort={sort} onSort={toggleSort} />
                  </tr>
                </thead>
                <tbody>
                  {sortedTenants.map((t) => (
                    <tr key={t.orgId} className="border-b border-slate-800/40 hover:bg-slate-800/20">
                      <td className="px-4 py-2.5 text-slate-200">{t.orgName}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-slate-300 tabular-nums">
                        {t.paymentCount.toLocaleString()}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-slate-300 tabular-nums">
                        {formatMoney(t.grossCents)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-indigo-300 tabular-nums font-semibold">
                        {formatMoney(t.feeCents)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-slate-400 tabular-nums">
                        {pct(t.takeRateBps)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-slate-800/20 border-t border-slate-700">
                    <td className="px-4 py-2.5 text-xs font-semibold text-white">Total</td>
                    <td className="px-4 py-2.5 text-right font-mono text-white tabular-nums font-semibold">
                      {totals.paymentCount.toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-white tabular-nums font-semibold">
                      {formatMoney(totals.grossCents)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-indigo-300 tabular-nums font-semibold">
                      {formatMoney(totals.feeCents)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-white tabular-nums font-semibold">
                      {pct(totals.takeRateBps)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </>
      )}

      {/* Methodology / source note */}
      <div className="flex items-start gap-2 text-[11px] text-slate-600">
        <Info size={12} className="mt-0.5 shrink-0" />
        <p>
          Platform-fee revenue is a platform-plane analytics figure, not a GL posting. Fees are
          derived from each merchant&apos;s fee schedule in force on the payment date applied to the
          collected amount (matching what was charged at payment time), counting only Stripe-processed
          card and ACH collections. Manual and imported payments earn no platform fee and are excluded.
        </p>
      </div>
    </div>
  );
}

// ── Rail summary card ────────────────────────────────────────────────────────
function RailCard({
  rail,
  icon: Icon,
  data,
  totalFee,
}: {
  rail: Rail;
  icon: typeof CreditCard;
  data: RailBreakdown | undefined;
  totalFee: number;
}) {
  const fee = data?.feeCents ?? 0;
  const gross = data?.grossCents ?? 0;
  const count = data?.paymentCount ?? 0;
  const share = totalFee > 0 ? Math.round((fee / totalFee) * 100) : 0;
  const label = rail === 'CARD' ? 'Card' : 'ACH / bank transfer';

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-indigo-500/10 flex items-center justify-center">
            <Icon size={16} className="text-indigo-300" />
          </div>
          <p className="text-sm font-medium text-slate-200">{label}</p>
        </div>
        <span className="text-2xs text-slate-500 font-mono">{share}% of fees</span>
      </div>
      <p className="text-xl font-semibold text-white font-mono tabular-nums">{formatMoney(fee)}</p>
      <div className="mt-2 h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
        <div className="h-full rounded-full bg-indigo-500" style={{ width: `${share}%` }} />
      </div>
      <div className="mt-3 flex items-center justify-between text-2xs text-slate-500">
        <span className="font-mono">{count.toLocaleString()} payment{count === 1 ? '' : 's'}</span>
        <span className="font-mono">{formatMoney(gross)} gross</span>
        <span className="font-mono">{pct(data?.takeRateBps ?? 0)}</span>
      </div>
    </div>
  );
}

// ── Sortable header cell ─────────────────────────────────────────────────────
function Th({
  label,
  sortKey,
  sort,
  onSort,
  align = 'right',
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: 'asc' | 'desc' };
  onSort: (k: SortKey) => void;
  align?: 'left' | 'right';
}) {
  const active = sort.key === sortKey;
  return (
    <th
      onClick={() => onSort(sortKey)}
      className={clsx(
        'px-4 py-2.5 text-2xs font-semibold uppercase text-slate-500 cursor-pointer select-none hover:text-slate-300 transition-colors',
        align === 'left' ? 'text-left' : 'text-right',
      )}
    >
      <span className={clsx('inline-flex items-center gap-1', align === 'right' && 'flex-row-reverse')}>
        {label}
        <ArrowUpDown size={11} className={active ? 'text-indigo-400' : 'text-slate-700'} />
      </span>
    </th>
  );
}

// ── Inline monthly trend chart ───────────────────────────────────────────────
function TrendChart({ trend }: { trend: TrendPoint[] }) {
  if (trend.length === 0) {
    return <p className="text-xs text-slate-600 py-8 text-center">No monthly activity in this period.</p>;
  }
  const W = 760;
  const H = 200;
  const padL = 8;
  const padR = 8;
  const padT = 12;
  const padB = 26;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const n = trend.length;
  const slot = innerW / n;
  const max = Math.max(...trend.map((t) => t.feeCents), 1);
  const barH = (v: number) => (v / max) * innerH;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Fee revenue by month">
      <line x1={padL} y1={padT + innerH} x2={W - padR} y2={padT + innerH} stroke="#334155" strokeWidth={1} />
      {trend.map((t, i) => {
        const h = Math.max(1, barH(t.feeCents));
        const x = padL + slot * i + slot * 0.2;
        const w = slot * 0.6;
        const y = padT + innerH - h;
        return (
          <g key={t.month}>
            <rect x={x} y={y} width={w} height={h} rx={2} fill="#6366f1" opacity={0.85}>
              <title>{`${monthLabel(t.month)} — ${(t.feeCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} · ${t.paymentCount} payments`}</title>
            </rect>
            <text
              x={padL + slot * i + slot / 2}
              y={H - 9}
              textAnchor="middle"
              fontSize={9}
              fill="#64748b"
              fontFamily="var(--font-mono, monospace)"
            >
              {monthLabel(t.month)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
