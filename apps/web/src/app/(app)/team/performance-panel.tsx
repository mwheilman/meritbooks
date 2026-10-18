'use client';

/**
 * Accounting-Manager Performance Scorecard.
 *
 * This is the manager's operating dashboard for the accounting team. It answers the
 * owner's questions directly and with REAL, deterministic data (no demo arrays):
 *   1. VOLUME by transaction count — items each person processed (JEs, bank-feed
 *      approvals, bills, invoices, reconciliations, approvals).
 *   2. VOLUME by dollars — how much MONEY each person posted / approved / issued /
 *      released (bigint cents).
 *   3. CLOSE-SCHEDULE ADHERENCE — on-time % vs the target close business-day,
 *      average days-to-close, and a per-period on-time/late history.
 *   4. REGULATORY FILING ADHERENCE — filed-on-time %, overdue count, and upcoming
 *      deadlines from the sales-tax filing calendar + compliance obligations.
 *
 * Fairness / anti-gaming (carried forward): the leaderboard headline is the
 * DIFFICULTY-WEIGHTED composite, every row shows quality (rework) beside output,
 * and anyone over the tenant rework gate is FLAGGED, not celebrated. Targets drive
 * RAG (green/amber/red) coloring so "good vs off-target" reads at a glance.
 *
 * Data: GET /api/team-performance (sibling-owned). Every metric renders "n/a" when
 * its source is null — metrics are only as honest as the underlying instrumentation.
 */

import { useMemo, useState } from 'react';
import {
  Trophy,
  Clock,
  Activity,
  ChevronDown,
  AlertCircle,
  Info,
  Lock,
  ArrowUpDown,
  Layers,
  DollarSign,
  CalendarCheck,
  FileCheck,
  Users,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { useQuery } from '@/hooks';
import { EmptyState, TableSkeleton } from '@/components/ui';

// ── Data contract (matches /api/team-performance) ────────────────────────────

interface Kpis {
  activePeople: number;
  weightedThroughput: number;
  totalActions: number;
  dollarsProcessedCents: number;
  avgCycleTimeHours: number | null;
  closeOnTimePct: number | null;
  filingOnTimePct: number | null;
  aiSharePct: number | null;
}

interface Scorecard {
  userId: string;
  name: string;
  throughput: { composite: number; totalActions: number; byFamily: Record<string, number> };
  dollars: { totalCents: number; byFamily: Record<string, number> };
  cycleTime: {
    uploadToCategorizedHrsAvg: number | null;
    categorizedToApprovedHrsAvg: number | null;
    approvalLatencyHrsAvg: number | null;
    approvalLatencyHrsMedian: number | null;
  };
  quality: {
    overrideRate: number | null;
    overrideSample: number;
    reworkRate: number | null;
    reworkSample: number;
    qualityFlag: boolean;
  };
  engagement: { activeDays: number; lastActive: string | null };
}

interface LeaderboardEntry {
  userId: string;
  name: string;
  composite: number;
  reworkRate: number | null;
  overrideRate: number | null;
  qualityFlag: boolean;
  rank: number;
}

interface ClosePeriodRow {
  periodId: string;
  label: string;
  entity: string;
  shortCode: string;
  status: string;
  dueDate: string;
  closedAt: string | null;
  daysToClose: number | null;
  onTime: boolean | null;
  openOverdue: boolean;
  ownerName: string | null;
}

interface Close {
  lookbackMonths: number;
  targetBusinessDay: number;
  closedCount: number;
  onTimeCount: number;
  lateCount: number;
  onTimePct: number | null;
  avgDaysToClose: number | null;
  openOverdueCount: number;
  periods: ClosePeriodRow[];
}

interface FilingRow {
  source: string;
  label: string;
  jurisdiction: string;
  dueDate: string;
  filedAt: string | null;
  status: 'filed' | 'overdue' | 'due-soon' | 'upcoming';
  onTime: boolean | null;
}

interface Filing {
  lookbackMonths: number;
  salesTaxAvailable: boolean;
  totalDue: number;
  filedCount: number;
  filedOnTime: number;
  filedLate: number;
  overdueCount: number;
  onTimePct: number | null;
  upcoming: FilingRow[];
  history: FilingRow[];
}

interface PerfResponse {
  scope: 'team' | 'self';
  period: { days: number; since: string; label: string };
  targets: { reworkGate: number; overrideWatch: number; closeBusinessDay: number };
  kpis: Kpis | null;
  people: Scorecard[];
  leaderboard: { entries: LeaderboardEntry[]; topPerformerUserId: string | null } | null;
  close: Close | null;
  filing: Filing | null;
}

type Scope = 'team' | 'self';
type PeriodKey = '7d' | '30d' | '90d' | 'qtd' | 'ytd';

const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: '7d', label: '7D' },
  { key: '30d', label: '30D' },
  { key: '90d', label: '90D' },
  { key: 'qtd', label: 'QTD' },
  { key: 'ytd', label: 'YTD' },
];

function daysForPeriod(key: PeriodKey): number {
  const now = new Date();
  switch (key) {
    case '7d':
      return 7;
    case '30d':
      return 30;
    case '90d':
      return 90;
    case 'qtd': {
      const q = Math.floor(now.getMonth() / 3);
      const start = new Date(now.getFullYear(), q * 3, 1);
      return Math.max(1, Math.ceil((now.getTime() - start.getTime()) / 86_400_000));
    }
    case 'ytd': {
      const start = new Date(now.getFullYear(), 0, 1);
      return Math.max(1, Math.ceil((now.getTime() - start.getTime()) / 86_400_000));
    }
  }
}

// ── Formatting + banding ─────────────────────────────────────────────────────

const NA = 'n/a';
const GOOD = 'text-emerald-400';
const WARN = 'text-amber-400';
const BAD = 'text-red-400';
const MUTED = 'text-slate-500';

function num(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return NA;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(v);
}

function money(cents: number | null | undefined): string {
  if (cents == null || Number.isNaN(cents)) return NA;
  return formatMoney(Math.round(cents));
}

/** Compact money for tight columns ($1.2M / $840K / $512). */
function moneyCompact(cents: number | null | undefined): string {
  if (cents == null || Number.isNaN(cents) || cents === 0) return cents === 0 ? '$0' : NA;
  const dollars = cents / 100;
  const abs = Math.abs(dollars);
  if (abs >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(dollars / 1_000).toFixed(1)}K`;
  return `$${dollars.toFixed(0)}`;
}

function pctStr(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return NA;
  const p = v <= 1 && v >= -1 ? v * 100 : v;
  return `${p.toFixed(1)}%`;
}

function hoursStr(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return NA;
  return v >= 48 ? `${(v / 24).toFixed(1)}d` : `${v.toFixed(1)}h`;
}

function relTime(iso: string | null | undefined): string {
  if (!iso) return NA;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return NA;
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function dateStr(iso: string | null | undefined): string {
  if (!iso) return NA;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return NA;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

/** Higher-is-better band for a rate (0..1). */
function onTimeColor(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return MUTED;
  if (v >= 0.95) return GOOD;
  if (v >= 0.8) return WARN;
  return BAD;
}

/** Rework band keyed to the tenant gate. */
function reworkColor(rate: number | null | undefined, gate: number): string {
  if (rate == null || Number.isNaN(rate)) return MUTED;
  if (rate <= gate / 2) return GOOD;
  if (rate <= gate) return WARN;
  return BAD;
}

/** Cycle-time band (lower better, hours). */
function cycleColor(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return MUTED;
  if (v <= 24) return GOOD;
  if (v <= 72) return WARN;
  return BAD;
}

// ── KPI header card ──────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  sub,
  icon: Icon,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: LucideIcon;
  accent?: string;
}) {
  return (
    <div className="card flex flex-col gap-2 p-4">
      <div className="flex items-center gap-2 text-caption uppercase tracking-caps text-slate-500">
        <Icon size={13} className="text-slate-500" />
        {label}
      </div>
      <div className={clsx('font-mono text-2xl font-semibold tabular-nums', accent ?? 'text-white')}>
        {value}
      </div>
      {sub && <div className="text-2xs text-slate-500">{sub}</div>}
    </div>
  );
}

function Stat({
  label,
  value,
  color,
  mono = true,
}: {
  label: string;
  value: string;
  color?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-2xs uppercase tracking-caps text-slate-500">{label}</span>
      <span className={clsx('text-sm font-medium', mono && 'font-mono tabular-nums', color ?? 'text-slate-200')}>
        {value}
      </span>
    </div>
  );
}

function FamilyBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2.5">
      <h5 className="text-2xs font-semibold uppercase tracking-caps text-slate-400">{title}</h5>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">{children}</div>
    </div>
  );
}

// ── Expandable per-person scorecard ──────────────────────────────────────────

function ScorecardCard({
  card,
  rank,
  gate,
  defaultOpen,
}: {
  card: Scorecard;
  rank?: number;
  gate: number;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const tp = card.throughput;
  const dl = card.dollars;
  const ct = card.cycleTime;
  const q = card.quality;
  const en = card.engagement;
  const flagged = q.qualityFlag;
  const bf = tp.byFamily ?? {};
  const df = dl.byFamily ?? {};

  return (
    <div className={clsx('card overflow-hidden p-0 transition-colors', flagged && 'ring-1 ring-red-500/30')}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.02] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
      >
        {rank != null && (
          <span className="w-6 shrink-0 font-mono text-sm tabular-nums text-slate-500">{rank}</span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white">{card.name || '—'}</p>
          <p className="truncate text-2xs uppercase tracking-caps text-slate-500">
            {tp.totalActions} items · {card.engagement.activeDays} active days
          </p>
        </div>
        {/* Volume ALWAYS paired with quality — anti-gaming. */}
        <div className="hidden items-center gap-5 sm:flex">
          <div className="text-right">
            <p className="font-mono text-sm font-semibold tabular-nums text-emerald-400">
              {moneyCompact(dl.totalCents)}
            </p>
            <p className="text-2xs text-slate-500">$ processed</p>
          </div>
          <div className="text-right">
            <p className="font-mono text-sm font-semibold tabular-nums text-white">{num(tp.composite)}</p>
            <p className="text-2xs text-slate-500">wtd output</p>
          </div>
          <div className="text-right">
            <p className={clsx('font-mono text-sm font-semibold tabular-nums', reworkColor(q.reworkRate, gate))}>
              {pctStr(q.reworkRate)}
            </p>
            <p className="text-2xs text-slate-500">rework</p>
          </div>
        </div>
        {flagged && (
          <span className="hidden rounded-full bg-red-500/10 px-2 py-0.5 text-2xs font-medium text-red-400 md:inline">
            Review quality
          </span>
        )}
        <ChevronDown size={16} className={clsx('shrink-0 text-slate-500 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="grid gap-5 border-t border-slate-800 bg-surface-950/40 px-4 py-4 md:grid-cols-2">
          <FamilyBlock title="Volume — by item count">
            <Stat label="Bank-feed" value={num(bf.categorize)} />
            <Stat label="Journal entries" value={num(bf.journal)} />
            <Stat label="Bills" value={num(bf.bill)} />
            <Stat label="Approvals" value={num(bf.approve)} />
            <Stat label="Reconciliations" value={num(bf.reconcile)} />
            <Stat label="Total items" value={num(tp.totalActions)} color="text-white" />
          </FamilyBlock>

          <FamilyBlock title="Volume — by dollars processed">
            <Stat label="JE posted" value={money(df.journal)} color="text-emerald-400" />
            <Stat label="Bills approved" value={money(df.bill)} color="text-emerald-400" />
            <Stat label="Invoices issued" value={money(df.invoice)} color="text-emerald-400" />
            <Stat label="Payroll approved" value={money(df.payroll)} color="text-emerald-400" />
            <Stat label="Payments released" value={money(df.payments)} color="text-emerald-400" />
            <Stat label="Total $" value={money(dl.totalCents)} color="text-white" />
          </FamilyBlock>

          <FamilyBlock title="Cycle time">
            <Stat
              label="Approval latency"
              value={hoursStr(ct.approvalLatencyHrsAvg)}
              color={cycleColor(ct.approvalLatencyHrsAvg)}
            />
            <Stat
              label="Approval (median)"
              value={hoursStr(ct.approvalLatencyHrsMedian)}
              color={cycleColor(ct.approvalLatencyHrsMedian)}
            />
            <Stat
              label="Coded → approved"
              value={hoursStr(ct.categorizedToApprovedHrsAvg)}
              color={cycleColor(ct.categorizedToApprovedHrsAvg)}
            />
          </FamilyBlock>

          <FamilyBlock title="Quality & engagement">
            <Stat
              label="Rework rate"
              value={pctStr(q.reworkRate)}
              color={reworkColor(q.reworkRate, gate)}
            />
            <Stat label="Override rate" value={pctStr(q.overrideRate)} />
            <Stat label="Composite" value={num(tp.composite)} color="text-white" />
            <Stat label="Last active" value={relTime(en.lastActive)} mono={false} />
          </FamilyBlock>
        </div>
      )}
    </div>
  );
}

// ── Leaderboard (manager-only, quality-gated, volume + dollars) ──────────────

type SortKey = 'rank' | 'composite' | 'items' | 'dollars' | 'cycle' | 'rework' | 'name';

function Leaderboard({
  entries,
  cards,
  gate,
}: {
  entries: LeaderboardEntry[];
  cards: Map<string, Scorecard>;
  gate: number;
}) {
  const [sortKey, setSortKey] = useState<SortKey>('rank');
  const [asc, setAsc] = useState(true);

  const enriched = useMemo(
    () =>
      entries.map((r) => {
        const c = cards.get(r.userId);
        return {
          ...r,
          items: c?.throughput.totalActions ?? 0,
          dollarsCents: c?.dollars.totalCents ?? 0,
          cycle: c?.cycleTime.approvalLatencyHrsAvg ?? null,
        };
      }),
    [entries, cards]
  );

  const sorted = useMemo(() => {
    const dir = asc ? 1 : -1;
    const val = (r: (typeof enriched)[number]): number | string => {
      switch (sortKey) {
        case 'name':
          return r.name?.toLowerCase() ?? '';
        case 'composite':
          return r.composite ?? -Infinity;
        case 'items':
          return r.items ?? -Infinity;
        case 'dollars':
          return r.dollarsCents ?? -Infinity;
        case 'cycle':
          return r.cycle ?? Infinity;
        case 'rework':
          return r.reworkRate ?? Infinity;
        default:
          return r.rank ?? Infinity;
      }
    };
    return [...enriched].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [enriched, sortKey, asc]);

  function toggleSort(k: SortKey) {
    if (k === sortKey) setAsc((v) => !v);
    else {
      setSortKey(k);
      setAsc(k === 'name' || k === 'rank' || k === 'cycle' || k === 'rework');
    }
  }

  const Header = ({
    k,
    children,
    align = 'left',
  }: {
    k: SortKey;
    children: React.ReactNode;
    align?: 'left' | 'right';
  }) => (
    <th
      className={clsx(
        'px-4 py-2.5 text-caption font-medium uppercase tracking-caps text-slate-500',
        align === 'left' ? 'text-left' : 'text-right'
      )}
    >
      <button
        onClick={() => toggleSort(k)}
        className={clsx(
          'inline-flex items-center gap-1 transition-colors hover:text-slate-300 focus:outline-none',
          align === 'right' && 'flex-row-reverse',
          sortKey === k && 'text-slate-300'
        )}
      >
        {children}
        <ArrowUpDown size={11} className={clsx(sortKey === k ? 'text-emerald-400' : 'text-slate-600')} />
      </button>
    </th>
  );

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-3">
        <Trophy size={15} className="text-emerald-400" />
        <h4 className="text-sm font-semibold text-white">Team leaderboard</h4>
      </div>
      <div className="flex items-start gap-2 border-b border-slate-800 bg-surface-950/40 px-4 py-2.5 text-2xs leading-relaxed text-slate-500">
        <Info size={13} className="mt-px shrink-0 text-slate-500" />
        <span>
          Ranked on <span className="text-slate-300">difficulty-weighted</span> output and{' '}
          <span className="text-slate-300">quality-gated</span> — volume and dollars are shown beside every score,
          and anyone over the {pctStr(gate)} rework gate is flagged for coaching, not celebrated.
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800">
              <Header k="rank">#</Header>
              <Header k="name">Member</Header>
              <Header k="items" align="right">
                Items
              </Header>
              <Header k="dollars" align="right">
                $ processed
              </Header>
              <Header k="composite" align="right">
                Wtd output
              </Header>
              <Header k="cycle" align="right">
                Avg cycle
              </Header>
              <Header k="rework" align="right">
                Rework
              </Header>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50">
            {sorted.map((r) => (
              <tr key={r.userId} className={clsx('table-row-hover', r.qualityFlag && 'bg-red-500/[0.03]')}>
                <td className="px-4 py-3 font-mono text-sm tabular-nums text-slate-400">{r.rank}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-white">{r.name || '—'}</span>
                    {r.qualityFlag && (
                      <span className="rounded-full bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-400">
                        quality
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-300">{num(r.items)}</td>
                <td className="px-4 py-3 text-right font-mono tabular-nums text-emerald-400">
                  {moneyCompact(r.dollarsCents)}
                </td>
                <td className="px-4 py-3 text-right font-mono font-semibold tabular-nums text-white">
                  {num(r.composite)}
                </td>
                <td className={clsx('px-4 py-3 text-right font-mono tabular-nums', cycleColor(r.cycle))}>
                  {hoursStr(r.cycle)}
                </td>
                <td className={clsx('px-4 py-3 text-right font-mono tabular-nums', reworkColor(r.reworkRate, gate))}>
                  {pctStr(r.reworkRate)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Close-schedule adherence ─────────────────────────────────────────────────

function CloseAdherence({ close }: { close: Close }) {
  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <CalendarCheck size={15} className="text-emerald-400" />
          <h4 className="text-sm font-semibold text-white">Close-schedule adherence</h4>
        </div>
        <span className="text-2xs text-slate-500">
          Target: hard-close by business day {close.targetBusinessDay} · trailing {close.lookbackMonths} months
        </span>
      </div>

      <div className="grid grid-cols-2 gap-px bg-slate-800/60 sm:grid-cols-4">
        <div className="bg-surface-900 p-4">
          <p className="text-2xs uppercase tracking-caps text-slate-500">On-time close</p>
          <p className={clsx('mt-1 font-mono text-xl font-semibold tabular-nums', onTimeColor(close.onTimePct))}>
            {pctStr(close.onTimePct)}
          </p>
        </div>
        <div className="bg-surface-900 p-4">
          <p className="text-2xs uppercase tracking-caps text-slate-500">Avg days-to-close</p>
          <p className="mt-1 font-mono text-xl font-semibold tabular-nums text-white">
            {close.avgDaysToClose == null ? NA : `${close.avgDaysToClose}d`}
          </p>
        </div>
        <div className="bg-surface-900 p-4">
          <p className="text-2xs uppercase tracking-caps text-slate-500">Closed periods</p>
          <p className="mt-1 font-mono text-xl font-semibold tabular-nums text-white">
            {close.onTimeCount}/{close.closedCount}
          </p>
        </div>
        <div className="bg-surface-900 p-4">
          <p className="text-2xs uppercase tracking-caps text-slate-500">Open &amp; overdue</p>
          <p
            className={clsx(
              'mt-1 font-mono text-xl font-semibold tabular-nums',
              close.openOverdueCount === 0 ? 'text-white' : BAD
            )}
          >
            {close.openOverdueCount}
          </p>
        </div>
      </div>

      {close.periods.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-slate-500">
          No fiscal periods in the trailing {close.lookbackMonths} months.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-y border-slate-800 text-caption uppercase tracking-caps text-slate-500">
                <th className="px-4 py-2 text-left font-medium">Period</th>
                <th className="px-4 py-2 text-left font-medium">Entity</th>
                <th className="px-4 py-2 text-left font-medium">Due by</th>
                <th className="px-4 py-2 text-left font-medium">Closed</th>
                <th className="px-4 py-2 text-right font-medium">Days</th>
                <th className="px-4 py-2 text-left font-medium">Owner</th>
                <th className="px-4 py-2 text-right font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {close.periods.map((p) => {
                const badge =
                  p.onTime === true
                    ? { cls: 'bg-emerald-500/10 text-emerald-400', label: 'On time', Icon: CheckCircle2 }
                    : p.onTime === false
                      ? { cls: 'bg-red-500/10 text-red-400', label: 'Late', Icon: AlertTriangle }
                      : p.openOverdue
                        ? { cls: 'bg-red-500/10 text-red-400', label: 'Overdue', Icon: AlertTriangle }
                        : { cls: 'bg-slate-500/10 text-slate-400', label: 'Open', Icon: Clock };
                const Badge = badge.Icon;
                return (
                  <tr key={p.periodId} className="table-row-hover">
                    <td className="px-4 py-2.5 font-mono tabular-nums text-slate-200">{p.label}</td>
                    <td className="px-4 py-2.5 text-slate-300">{p.shortCode || p.entity}</td>
                    <td className="px-4 py-2.5 font-mono tabular-nums text-slate-400">{dateStr(p.dueDate)}</td>
                    <td className="px-4 py-2.5 font-mono tabular-nums text-slate-400">{dateStr(p.closedAt)}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-300">
                      {p.daysToClose == null ? NA : `${p.daysToClose}d`}
                    </td>
                    <td className="px-4 py-2.5 text-slate-400">{p.ownerName ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right">
                      <span
                        className={clsx(
                          'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium',
                          badge.cls
                        )}
                      >
                        <Badge size={11} />
                        {badge.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Filing-schedule adherence ────────────────────────────────────────────────

function FilingAdherence({ filing }: { filing: Filing }) {
  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <FileCheck size={15} className="text-emerald-400" />
          <h4 className="text-sm font-semibold text-white">Regulatory filing adherence</h4>
        </div>
        <span className="text-2xs text-slate-500">
          Sales tax + compliance obligations · trailing {filing.lookbackMonths} months
        </span>
      </div>

      <div className="grid grid-cols-2 gap-px bg-slate-800/60 sm:grid-cols-4">
        <div className="bg-surface-900 p-4">
          <p className="text-2xs uppercase tracking-caps text-slate-500">On-time filing</p>
          <p className={clsx('mt-1 font-mono text-xl font-semibold tabular-nums', onTimeColor(filing.onTimePct))}>
            {pctStr(filing.onTimePct)}
          </p>
        </div>
        <div className="bg-surface-900 p-4">
          <p className="text-2xs uppercase tracking-caps text-slate-500">Filed</p>
          <p className="mt-1 font-mono text-xl font-semibold tabular-nums text-white">
            {filing.filedOnTime}/{filing.filedCount}
          </p>
        </div>
        <div className="bg-surface-900 p-4">
          <p className="text-2xs uppercase tracking-caps text-slate-500">Filed late</p>
          <p
            className={clsx(
              'mt-1 font-mono text-xl font-semibold tabular-nums',
              filing.filedLate === 0 ? 'text-white' : WARN
            )}
          >
            {filing.filedLate}
          </p>
        </div>
        <div className="bg-surface-900 p-4">
          <p className="text-2xs uppercase tracking-caps text-slate-500">Overdue</p>
          <p
            className={clsx(
              'mt-1 font-mono text-xl font-semibold tabular-nums',
              filing.overdueCount === 0 ? 'text-white' : BAD
            )}
          >
            {filing.overdueCount}
          </p>
        </div>
      </div>

      <div className="grid gap-px bg-slate-800/60 md:grid-cols-2">
        {/* Upcoming / overdue deadlines */}
        <div className="bg-surface-900 p-4">
          <h5 className="mb-3 text-2xs font-semibold uppercase tracking-caps text-slate-400">Upcoming deadlines</h5>
          {filing.upcoming.length === 0 ? (
            <p className="text-sm text-slate-500">Nothing due in the window.</p>
          ) : (
            <ul className="space-y-2">
              {filing.upcoming.map((r, i) => (
                <li key={`${r.label}-${i}`} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-sm text-slate-300">{r.label}</span>
                  <span
                    className={clsx(
                      'shrink-0 font-mono text-2xs tabular-nums',
                      r.status === 'overdue' ? BAD : r.status === 'due-soon' ? WARN : 'text-slate-400'
                    )}
                  >
                    {dateStr(r.dueDate)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {/* Filed history */}
        <div className="bg-surface-900 p-4">
          <h5 className="mb-3 text-2xs font-semibold uppercase tracking-caps text-slate-400">Recently filed</h5>
          {filing.history.length === 0 ? (
            <p className="text-sm text-slate-500">No filings recorded yet.</p>
          ) : (
            <ul className="space-y-2">
              {filing.history.map((r, i) => (
                <li key={`${r.label}-${i}`} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-sm text-slate-300">{r.label}</span>
                  <span
                    className={clsx(
                      'inline-flex shrink-0 items-center gap-1 font-mono text-2xs tabular-nums',
                      r.onTime === false ? BAD : GOOD
                    )}
                  >
                    {r.onTime === false ? <AlertTriangle size={11} /> : <CheckCircle2 size={11} />}
                    {dateStr(r.filedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {!filing.salesTaxAvailable && (
        <div className="border-t border-slate-800 bg-surface-950/40 px-4 py-2.5 text-2xs text-slate-500">
          Sales-tax filing records unavailable — showing compliance obligations only. On-time % reflects what is
          recorded.
        </div>
      )}
    </div>
  );
}

// ── Panel ────────────────────────────────────────────────────────────────────

export function PerformancePanel({ scope }: { scope: Scope }) {
  const [period, setPeriod] = useState<PeriodKey>('30d');
  const [cardSort, setCardSort] = useState<'output' | 'dollars' | 'rework' | 'name'>('output');

  const days = useMemo(() => daysForPeriod(period), [period]);
  const params = useMemo(() => ({ scope, days: String(days) }), [scope, days]);

  const { data, isLoading, error, refetch } = useQuery<PerfResponse>('/api/team-performance', params, {
    scope: false, // org-wide lens; never sub-filter by active company
  });

  const isManager = scope === 'team';
  const people = useMemo(() => data?.people ?? [], [data]);
  const kpis = data?.kpis ?? null;
  const close = data?.close ?? null;
  const filing = data?.filing ?? null;
  const gate = data?.targets?.reworkGate ?? 0.08;

  const cardMap = useMemo(() => {
    const m = new Map<string, Scorecard>();
    for (const c of people) m.set(c.userId, c);
    return m;
  }, [people]);

  const sortedCards = useMemo(() => {
    const val = (c: Scorecard): number | string => {
      switch (cardSort) {
        case 'name':
          return c.name?.toLowerCase() ?? '';
        case 'dollars':
          return -(c.dollars.totalCents ?? 0);
        case 'rework':
          return c.quality.reworkRate ?? Infinity;
        default:
          return -(c.throughput.composite ?? 0);
      }
    };
    return [...people].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (typeof av === 'number' && typeof bv === 'number') return av - bv;
      return String(av).localeCompare(String(bv));
    });
  }, [people, cardSort]);

  const hasAnything = people.length > 0 || (data?.leaderboard?.entries.length ?? 0) > 0;

  return (
    <div className="space-y-6">
      {/* Controls: real date-range selector wired to ?days. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          className="flex items-center gap-0.5 rounded-lg border border-slate-800 bg-surface-850 p-0.5"
          role="group"
          aria-label="Date range"
        >
          {PERIODS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              aria-pressed={period === p.key}
              className={clsx(
                'rounded-md px-3 py-1 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40',
                period === p.key ? 'bg-brand-500/10 text-emerald-400' : 'text-slate-400 hover:text-slate-200'
              )}
            >
              {p.label}
            </button>
          ))}
        </div>

        {isManager && people.length > 0 && (
          <label className="flex items-center gap-2 text-xs text-slate-500">
            Sort cards
            <select
              value={cardSort}
              onChange={(e) => setCardSort(e.target.value as typeof cardSort)}
              className="input h-8 w-auto py-1 text-xs"
            >
              <option value="output">Weighted output</option>
              <option value="dollars">Dollars processed</option>
              <option value="rework">Rework rate</option>
              <option value="name">Name</option>
            </select>
          </label>
        )}
      </div>

      {!isManager && (
        <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-surface-850 px-3.5 py-2.5 text-xs text-slate-400">
          <Lock size={14} className="shrink-0 text-slate-500" />
          You&apos;re viewing your own scorecard. The team leaderboard, close/filing KPIs and peers&apos;
          scorecards are visible to managers only.
        </div>
      )}

      {isLoading ? (
        <TableSkeleton rows={6} cols={4} />
      ) : error ? (
        <div className="card flex flex-col items-center justify-center px-4 py-16 text-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-danger/10">
            <AlertCircle size={24} className="text-danger-fg" />
          </div>
          <h3 className="mb-1 text-sm font-medium text-slate-200">Couldn&apos;t load performance</h3>
          <p className="mb-4 max-w-sm text-sm text-slate-500">{error}</p>
          <button onClick={refetch} className="btn-secondary btn-sm">
            Try again
          </button>
        </div>
      ) : !hasAnything && !close && !filing ? (
        <div className="card">
          <EmptyState
            icon={Activity}
            title="No activity logged in this window"
            description="Once the team takes action in this period — categorizing, approving, posting, closing, filing — their performance appears here. Try a longer date range."
          />
        </div>
      ) : (
        <>
          {/* KPI headline — the owner's five metrics, up top. */}
          {isManager && kpis && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
              <KpiCard
                label="Weighted throughput"
                value={num(kpis.weightedThroughput)}
                sub={`${num(kpis.totalActions)} items`}
                icon={Layers}
                accent="text-emerald-400"
              />
              <KpiCard
                label="Dollars processed"
                value={moneyCompact(kpis.dollarsProcessedCents)}
                sub="posted · approved · issued"
                icon={DollarSign}
                accent="text-emerald-400"
              />
              <KpiCard
                label="Avg cycle time"
                value={hoursStr(kpis.avgCycleTimeHours)}
                sub="median approval latency"
                icon={Clock}
                accent={cycleColor(kpis.avgCycleTimeHours)}
              />
              <KpiCard
                label="Close on-time"
                value={pctStr(kpis.closeOnTimePct)}
                sub="vs target close day"
                icon={CalendarCheck}
                accent={onTimeColor(kpis.closeOnTimePct)}
              />
              <KpiCard
                label="Filing on-time"
                value={pctStr(kpis.filingOnTimePct)}
                sub="regulatory filings"
                icon={FileCheck}
                accent={onTimeColor(kpis.filingOnTimePct)}
              />
              <KpiCard
                label="Active people"
                value={num(kpis.activePeople)}
                sub={kpis.aiSharePct != null ? `${kpis.aiSharePct}% AI-actioned` : 'in this window'}
                icon={Users}
              />
            </div>
          )}

          {/* Leaderboard — manager only, quality-gated, volume + dollars. */}
          {isManager && data?.leaderboard && data.leaderboard.entries.length > 0 && (
            <Leaderboard entries={data.leaderboard.entries} cards={cardMap} gate={gate} />
          )}

          {/* Close-schedule adherence — manager only. */}
          {isManager && close && <CloseAdherence close={close} />}

          {/* Filing-schedule adherence — manager only. */}
          {isManager && filing && <FilingAdherence filing={filing} />}

          {/* Per-person scorecards (expandable). */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-semibold text-white">{isManager ? 'Scorecards' : 'Your scorecard'}</h4>
              {isManager && (
                <span className="font-mono text-2xs tabular-nums text-slate-500">{people.length}</span>
              )}
            </div>
            {sortedCards.length === 0 ? (
              <div className="card">
                <EmptyState icon={Activity} title="No scorecard yet" description="No logged activity in this window." />
              </div>
            ) : (
              <div className="space-y-2">
                {sortedCards.map((c, i) => (
                  <ScorecardCard
                    key={c.userId}
                    card={c}
                    gate={gate}
                    rank={isManager ? i + 1 : undefined}
                    defaultOpen={!isManager || sortedCards.length === 1}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
