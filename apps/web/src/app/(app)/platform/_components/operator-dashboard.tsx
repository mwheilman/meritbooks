'use client';

/**
 * Operator Console — business dashboard (platform plane).
 *
 * Renders the operator's cross-tenant business at a glance: how many tenants it serves,
 * what it earns, and what those tenants cost to run. Every figure is an explicit
 * cross-tenant aggregate from /api/platform/overview (admin client, platform-staff
 * gated) — never one tenant's book leaking into another's view.
 *
 * Honesty is a feature here: realized fee, AI cost, storage usage, tenants and seats
 * are REAL (measured). Storage COST is a labeled ESTIMATE. Subscription revenue is
 * NOT-YET-INSTRUMENTED — no billing/price source exists, so we render a "connect
 * billing" card instead of a fabricated number.
 */

import { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { useQuery } from '@/hooks';
import {
  Loader2, AlertCircle, Building2, Users, DollarSign, Cpu, HardDrive, Wallet,
  TrendingUp, ArrowUpDown, Info, CreditCard, PlugZap, ArrowUpRight, ArrowDownRight,
} from 'lucide-react';

// ── Types (mirror /api/platform/overview) ────────────────────────────────────
interface TenantSummary {
  orgId: string;
  orgName: string;
  onboarded: boolean;
  createdAt: string | null;
  activeSeats: number;
  aiCostCents: number;
  storageBytes: number;
  realizedFeeCents: number;
}
interface SignupPoint {
  month: string;
  newTenants: number;
  cumulativeTenants: number;
}
interface OverviewResponse {
  window: { from: string | null; to: string | null };
  tenants: {
    total: number;
    onboarded: number;
    activeSeats: number;
    newInWindow: number;
    signupTrend: SignupPoint[];
    recent: { orgId: string; orgName: string; createdAt: string | null; onboarded: boolean }[];
  };
  revenue: {
    realizedFeeCents: number;
    grossProcessedCents: number;
    subscriptionMrrCents: number | null;
    subscriptionStatus: string;
  };
  costs: {
    aiCostCents: number;
    aiCallCount: number;
    storageBytes: number;
    storageDocCount: number;
    storageCostCentsEstimate: number;
    storageCostIsEstimate: boolean;
    totalInstrumentedCostCents: number;
  };
  perTenant: TenantSummary[];
  meta: {
    generatedAt: string;
    storageRatePerGbMonthCents: number;
  };
}

// ── Period presets (self-contained; mirrors the fee-revenue report) ──────────
type PresetKey = 'mtd' | 'last_30' | 'last_month' | 'qtd' | 'ytd' | 'ttm' | 'all';
const PRESETS: { key: PresetKey; label: string }[] = [
  { key: 'mtd', label: 'This month' },
  { key: 'last_30', label: 'Last 30 days' },
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
    case 'last_30':
      return { from: iso(new Date(Date.UTC(y, m, now.getUTCDate() - 29))), to: today };
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

// ── Formatting helpers ───────────────────────────────────────────────────────
const BYTES_PER_GB = 1024 * 1024 * 1024;
const fmtStorage = (bytes: number): string => {
  if (bytes <= 0) return '0 MB';
  const gb = bytes / BYTES_PER_GB;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
};
const monthLabel = (ym: string) => {
  const [yy, mm] = ym.split('-').map(Number);
  return new Date(Date.UTC(yy, mm - 1, 1)).toLocaleDateString('en-US', {
    month: 'short',
    timeZone: 'UTC',
  });
};
const dateLabel = (s: string | null) =>
  s
    ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';

type SortKey = 'orgName' | 'activeSeats' | 'aiCostCents' | 'storageBytes' | 'realizedFeeCents';

export function OperatorDashboard() {
  const [preset, setPreset] = useState<PresetKey>('ttm');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'realizedFeeCents',
    dir: 'desc',
  });

  const range = useMemo(() => rangeFor(preset), [preset]);
  const params = useMemo(() => {
    const p: Record<string, string> = {};
    if (range.from) p.from = range.from;
    if (range.to) p.to = range.to;
    return p;
  }, [range]);

  // scope:false — this console is cross-tenant and must NOT inherit the header's
  // active-company location filter.
  const { data, isLoading, error } = useQuery<OverviewResponse>(
    '/api/platform/overview',
    params,
    { scope: false },
  );

  const Selector = (
    <div className="flex items-center gap-2">
      <label className="text-2xs uppercase tracking-wider text-slate-500">Window</label>
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
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card p-5 animate-pulse">
              <div className="h-3 w-24 bg-slate-800 rounded" />
              <div className="mt-4 h-7 w-28 bg-slate-800 rounded" />
            </div>
          ))}
        </div>
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 text-indigo-400 animate-spin" />
        </div>
      </div>
    );
  }

  // ── Error ────────────────────────────────────────────────────────────────
  if (error || !data) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">{Selector}</div>
        <div className="card p-10 text-center">
          <AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" />
          <p className="text-sm text-red-400">{error ?? 'No data returned.'}</p>
          <p className="text-xs text-slate-500 mt-1">
            The operator overview could not be loaded. This view is restricted to platform staff.
          </p>
        </div>
      </div>
    );
  }

  const { tenants, revenue, costs, perTenant } = data;
  const netCents = revenue.realizedFeeCents - costs.totalInstrumentedCostCents;

  const sortedTenants = [...perTenant].sort((a, b) => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    if (sort.key === 'orgName') return a.orgName.localeCompare(b.orgName) * dir;
    return (a[sort.key] - b[sort.key]) * dir;
  });
  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));

  return (
    <div className="space-y-5">
      {/* Controls */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        {Selector}
        <div className="flex items-center gap-1.5 text-2xs text-indigo-300/80">
          <Cpu size={12} className="text-indigo-400" />
          Platform-plane analytics · cross-tenant aggregate
        </div>
      </div>

      {/* Top KPI grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Kpi
          icon={Building2}
          label="Active tenants"
          value={tenants.total.toLocaleString()}
          sub={`${tenants.onboarded} onboarded · +${tenants.newInWindow} this window`}
          accent="indigo"
        />
        <Kpi
          icon={Users}
          label="Active seats"
          value={tenants.activeSeats.toLocaleString()}
          sub="Active memberships across tenants"
          accent="slate"
        />
        <Kpi
          icon={DollarSign}
          label="Realized fee revenue"
          value={formatMoney(revenue.realizedFeeCents)}
          sub={`${formatMoney(revenue.grossProcessedCents)} gross processed`}
          accent="emerald"
          mono
        />
        <Kpi
          icon={Wallet}
          label="Total cost (instrumented)"
          value={formatMoney(costs.totalInstrumentedCostCents)}
          sub="AI/API + estimated storage"
          accent="red"
          mono
        />
      </div>

      {/* Cost detail + net + subscription-not-instrumented */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        <Kpi
          icon={Cpu}
          label="AI / API cost"
          value={formatMoney(costs.aiCostCents)}
          sub={`${costs.aiCallCount.toLocaleString()} metered call${costs.aiCallCount === 1 ? '' : 's'}`}
          accent="indigo"
          mono
        />
        <Kpi
          icon={HardDrive}
          label="Storage usage"
          value={fmtStorage(costs.storageBytes)}
          sub={
            <>
              {costs.storageDocCount.toLocaleString()} docs ·{' '}
              <span className="text-amber-400/90">~{formatMoney(costs.storageCostCentsEstimate)} est.</span>
            </>
          }
          accent="slate"
          mono
        />
        <NetCard netCents={netCents} />
        <SubscriptionCard mrrCents={revenue.subscriptionMrrCents} />
      </div>

      {/* Tenant signup trend */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
            <TrendingUp size={13} className="text-indigo-400" /> Tenant growth · last 12 months
          </p>
          <span className="text-2xs text-slate-500 font-mono">{tenants.total} total</span>
        </div>
        <SignupChart trend={tenants.signupTrend} />
      </div>

      {/* Per-tenant table */}
      <div className="card overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-800 flex items-center gap-2">
          <Building2 size={14} className="text-slate-400" />
          <p className="text-xs font-semibold text-slate-300">
            By tenant
            <span className="text-slate-600 font-normal">
              {' '}
              · {perTenant.length} tenant{perTenant.length === 1 ? '' : 's'}
            </span>
          </p>
        </div>
        {perTenant.length === 0 ? (
          <div className="p-12 text-center">
            <Building2 size={24} className="text-slate-600 mx-auto mb-2" />
            <p className="text-sm text-slate-400">No tenants provisioned yet.</p>
            <p className="text-xs text-slate-600 mt-1">
              As organizations sign up, their seats, cost, and fee revenue appear here.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800">
                  <Th label="Tenant" sortKey="orgName" sort={sort} onSort={toggleSort} align="left" />
                  <Th label="Seats" sortKey="activeSeats" sort={sort} onSort={toggleSort} />
                  <Th label="AI / API cost" sortKey="aiCostCents" sort={sort} onSort={toggleSort} />
                  <Th label="Storage" sortKey="storageBytes" sort={sort} onSort={toggleSort} />
                  <Th label="Realized fee" sortKey="realizedFeeCents" sort={sort} onSort={toggleSort} />
                </tr>
              </thead>
              <tbody>
                {sortedTenants.map((t) => (
                  <tr key={t.orgId} className="border-b border-slate-800/40 hover:bg-slate-800/20">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="text-slate-200">{t.orgName}</span>
                        {!t.onboarded && (
                          <span className="text-[10px] uppercase tracking-wider text-amber-400/80 bg-amber-500/10 rounded px-1.5 py-0.5">
                            Onboarding
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-slate-300 tabular-nums">
                      {t.activeSeats.toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-indigo-300 tabular-nums">
                      {t.aiCostCents > 0 ? formatMoney(t.aiCostCents) : <span className="text-slate-600">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-slate-300 tabular-nums">
                      {t.storageBytes > 0 ? fmtStorage(t.storageBytes) : <span className="text-slate-600">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-emerald-400 tabular-nums font-semibold">
                      {t.realizedFeeCents > 0 ? formatMoney(t.realizedFeeCents) : <span className="text-slate-600">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-slate-800/20 border-t border-slate-700">
                  <td className="px-4 py-2.5 text-xs font-semibold text-white">Total</td>
                  <td className="px-4 py-2.5 text-right font-mono text-white tabular-nums font-semibold">
                    {tenants.activeSeats.toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-indigo-300 tabular-nums font-semibold">
                    {formatMoney(costs.aiCostCents)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-white tabular-nums font-semibold">
                    {fmtStorage(costs.storageBytes)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-emerald-400 tabular-nums font-semibold">
                    {formatMoney(revenue.realizedFeeCents)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* Methodology / honesty note */}
      <div className="flex items-start gap-2 text-[11px] text-slate-600">
        <Info size={12} className="mt-0.5 shrink-0" />
        <p>
          Tenants, seats, AI/API cost, storage usage and realized processor-fee revenue are measured
          from live data (core.organizations, core.memberships, core.ai_usage_log, public.documents,
          and the payment sub-ledger). Storage cost is an <span className="text-amber-400/80">estimate</span>{' '}
          (usage × ${(data.meta.storageRatePerGbMonthCents / 100).toFixed(3)}/GB-month) and storage usage
          is a point-in-time snapshot, not windowed. Subscription/plan revenue is{' '}
          <span className="text-slate-400">not yet instrumented</span> — no billing source exists — so it
          is shown as unconnected rather than estimated.
        </p>
      </div>
    </div>
  );
}

// ── KPI card ─────────────────────────────────────────────────────────────────
type Accent = 'indigo' | 'emerald' | 'red' | 'slate';
const ACCENT: Record<Accent, { bg: string; fg: string }> = {
  indigo: { bg: 'bg-indigo-500/15', fg: 'text-indigo-300' },
  emerald: { bg: 'bg-emerald-500/10', fg: 'text-emerald-400' },
  red: { bg: 'bg-red-500/10', fg: 'text-red-400' },
  slate: { bg: 'bg-slate-700/40', fg: 'text-slate-300' },
};

function Kpi({
  icon: Icon,
  label,
  value,
  sub,
  accent = 'slate',
  mono = false,
}: {
  icon: typeof Building2;
  label: string;
  value: string;
  sub?: React.ReactNode;
  accent?: Accent;
  mono?: boolean;
}) {
  const a = ACCENT[accent];
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between">
        <p className="text-sm text-slate-400">{label}</p>
        <div className={clsx('h-8 w-8 rounded-lg flex items-center justify-center', a.bg)}>
          <Icon size={16} className={a.fg} />
        </div>
      </div>
      <p
        className={clsx(
          'mt-2 text-2xl font-semibold text-white tracking-tight',
          mono && 'font-mono tabular-nums',
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-1 text-2xs text-slate-500">{sub}</p>}
    </div>
  );
}

// ── Net (revenue − cost) card ────────────────────────────────────────────────
function NetCard({ netCents }: { netCents: number }) {
  const positive = netCents >= 0;
  return (
    <div
      className={clsx(
        'card p-5 border',
        positive ? 'border-emerald-500/20 bg-emerald-500/[0.04]' : 'border-red-500/20 bg-red-500/[0.04]',
      )}
    >
      <div className="flex items-start justify-between">
        <p className="text-sm text-slate-400">Net (fee − cost)</p>
        <div
          className={clsx(
            'h-8 w-8 rounded-lg flex items-center justify-center',
            positive ? 'bg-emerald-500/15' : 'bg-red-500/15',
          )}
        >
          {positive ? (
            <ArrowUpRight size={16} className="text-emerald-400" />
          ) : (
            <ArrowDownRight size={16} className="text-red-400" />
          )}
        </div>
      </div>
      <p
        className={clsx(
          'mt-2 text-2xl font-semibold tracking-tight font-mono tabular-nums',
          positive ? 'text-emerald-400' : 'text-red-400',
        )}
      >
        {formatMoney(netCents)}
      </p>
      <p className="mt-1 text-2xs text-slate-500">Realized fee less instrumented cost</p>
    </div>
  );
}

// ── Subscription-not-instrumented card ───────────────────────────────────────
function SubscriptionCard({ mrrCents }: { mrrCents: number | null }) {
  if (mrrCents !== null) {
    // Future: once billing is connected, this renders the real MRR.
    return (
      <Kpi icon={CreditCard} label="Subscription MRR" value={formatMoney(mrrCents)} accent="emerald" mono />
    );
  }
  return (
    <div className="card p-5 border border-dashed border-slate-700 bg-slate-900/40">
      <div className="flex items-start justify-between">
        <p className="text-sm text-slate-400">Subscription MRR</p>
        <div className="h-8 w-8 rounded-lg bg-slate-700/40 flex items-center justify-center">
          <PlugZap size={16} className="text-slate-400" />
        </div>
      </div>
      <p className="mt-2 text-sm font-medium text-slate-300">Not yet instrumented</p>
      <p className="mt-1 text-2xs text-slate-500">
        No billing/plan-price source is connected. Wire tenant billing to populate real MRR here — no
        figure is estimated.
      </p>
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

// ── Tenant-growth chart (cumulative line + monthly signup bars) ───────────────
function SignupChart({ trend }: { trend: SignupPoint[] }) {
  if (trend.length === 0) {
    return <p className="text-xs text-slate-600 py-8 text-center">No tenant history yet.</p>;
  }
  const W = 760;
  const H = 180;
  const padL = 8;
  const padR = 8;
  const padT = 12;
  const padB = 26;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const n = trend.length;
  const slot = innerW / n;
  const maxCum = Math.max(...trend.map((t) => t.cumulativeTenants), 1);
  const y = (v: number) => padT + innerH - (v / maxCum) * innerH;

  const linePts = trend
    .map((t, i) => `${padL + slot * i + slot / 2},${y(t.cumulativeTenants)}`)
    .join(' ');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Tenant growth by month">
      <line x1={padL} y1={padT + innerH} x2={W - padR} y2={padT + innerH} stroke="#334155" strokeWidth={1} />
      {trend.map((t, i) => {
        const h = t.newTenants > 0 ? Math.max(2, (t.newTenants / maxCum) * innerH) : 0;
        const x = padL + slot * i + slot * 0.28;
        const w = slot * 0.44;
        const by = padT + innerH - h;
        return (
          <g key={t.month}>
            {h > 0 && (
              <rect x={x} y={by} width={w} height={h} rx={2} fill="#6366f1" opacity={0.35}>
                <title>{`${monthLabel(t.month)} — +${t.newTenants} new · ${t.cumulativeTenants} total`}</title>
              </rect>
            )}
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
      <polyline points={linePts} fill="none" stroke="#818cf8" strokeWidth={1.75} />
      {trend.map((t, i) => (
        <circle
          key={t.month}
          cx={padL + slot * i + slot / 2}
          cy={y(t.cumulativeTenants)}
          r={2.5}
          fill="#a5b4fc"
        >
          <title>{`${monthLabel(t.month)} — ${t.cumulativeTenants} tenants`}</title>
        </circle>
      ))}
    </svg>
  );
}
