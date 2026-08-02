'use client';

/**
 * Team Performance panel (FPB: Team Performance / Bookkeeper Scorecards).
 *
 * Renders the manager/admin performance lens (roll-up KPIs + quality-gated
 * leaderboard + per-person expandable scorecards) OR, for a non-manager, ONLY
 * that person's own scorecard — the privacy boundary from FPB Dimension 14/15.
 *
 * ANTI-GAMING (FPB Dimension 11) is surfaced, not just implemented server-side:
 *   - the leaderboard headline is the *difficulty-weighted composite*, and every
 *     row shows the QUALITY metric (rework %) next to it so a rank can never read
 *     as raw volume;
 *   - a caption states the ranking is weighted + for coaching, not raw output;
 *   - anyone over the rework threshold is FLAGGED (amber/red), not celebrated.
 *
 * Data comes from GET /api/team-performance (sibling-owned). The shape is treated
 * defensively: every metric renders "n/a" when its source is null (metrics are
 * only as honest as the underlying action_log instrumentation — FPB Dim 16).
 */

import { useMemo, useState } from 'react';
import {
  Trophy,
  Clock,
  Activity,
  ShieldCheck,
  ChevronDown,
  AlertCircle,
  Info,
  Lock,
  ArrowUpDown,
  Gauge,
  Layers,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery } from '@/hooks';
import { EmptyState, TableSkeleton } from '@/components/ui';

// ── Data contract (assumed sibling shape; read defensively) ──────────────────

interface TeamRollup {
  totalThroughput?: number | null;
  weightedThroughput?: number | null;
  avgCycleTimeHours?: number | null;
  autonomyRate?: number | null;
  openBacklog?: number | null;
}

interface LeaderboardRow {
  userId: string;
  name: string;
  compositeScore: number | null;
  rank: number;
  role?: string | null;
}

interface Scorecard {
  userId: string;
  name: string;
  role: string | null;
  throughput: {
    categorizations?: number | null;
    approvals?: number | null;
    jes?: number | null;
    bills?: number | null;
    weighted?: number | null;
  } | null;
  cycleTime: {
    uploadToCategorizedHours?: number | null;
    categorizedToApprovedHours?: number | null;
    approvalLatencyHours?: number | null;
  } | null;
  quality: {
    overrideRate?: number | null;
    reworkRate?: number | null;
    exceptionsResolved?: number | null;
  } | null;
  autonomy: {
    humanActions?: number | null;
    aiActions?: number | null;
    autonomyRate?: number | null;
  } | null;
  engagement: {
    activeDays?: number | null;
    lastActiveAt?: string | null;
    backlog?: number | null;
  } | null;
}

interface PerfResponse {
  period: string;
  team?: TeamRollup | null;
  leaderboard?: LeaderboardRow[] | null;
  scorecards?: Scorecard[] | null;
}

type Scope = 'team' | 'self';
type PeriodKey = '7d' | '30d' | 'qtd' | 'ytd';

const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: '7d', label: '7D' },
  { key: '30d', label: '30D' },
  { key: 'qtd', label: 'QTD' },
  { key: 'ytd', label: 'YTD' },
];

// Tenant-configurable in the real config table (FPB Dim 6/15); sensible defaults here.
const REWORK_GOOD = 3; // % — < 3% healthy
const REWORK_WARN = 8; // % — > 8% is a coaching signal
const OVERRIDE_GOOD = 15;
const OVERRIDE_WARN = 30;
const CYCLE_GOOD_H = 48;
const CYCLE_WARN_H = 96;
const APPROVAL_GOOD_H = 24;
const APPROVAL_WARN_H = 72;

// ── Formatting + banding helpers ─────────────────────────────────────────────

const NA = 'n/a';

function num(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return NA;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(v);
}

/** Normalize a rate that may arrive as 0..1 or 0..100 into a percent number. */
function toPct(v: number | null | undefined): number | null {
  if (v == null || Number.isNaN(v)) return null;
  return v <= 1 && v >= -1 ? v * 100 : v;
}

function pctStr(v: number | null | undefined): string {
  const p = toPct(v);
  return p == null ? NA : `${p.toFixed(1)}%`;
}

function hoursStr(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return NA;
  return v >= 48 ? `${(v / 24).toFixed(1)}d` : `${v.toFixed(1)}h`;
}

function relTime(iso: string | null | undefined): string {
  if (!iso) return NA;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return NA;
  const diff = Date.now() - t;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

const SLATE = 'text-slate-300';
const GOOD = 'text-emerald-400';
const WARN = 'text-amber-400';
const BAD = 'text-red-400';

/** Lower-is-better band (rework, override, cycle time, backlog). */
function lowerColor(v: number | null | undefined, good: number, warn: number): string {
  if (v == null || Number.isNaN(v)) return 'text-slate-500';
  if (v <= good) return GOOD;
  if (v <= warn) return WARN;
  return BAD;
}

function reworkColor(v: number | null | undefined): string {
  return lowerColor(toPct(v) ?? undefined, REWORK_GOOD, REWORK_WARN);
}
function overrideColor(v: number | null | undefined): string {
  return lowerColor(toPct(v) ?? undefined, OVERRIDE_GOOD, OVERRIDE_WARN);
}
function backlogColor(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return 'text-slate-500';
  if (v === 0) return GOOD;
  if (v <= 25) return WARN;
  return BAD;
}
/** Higher-is-better band (autonomy). Low autonomy is neutral, not "bad". */
function autonomyColor(v: number | null | undefined): string {
  const p = toPct(v);
  if (p == null) return 'text-slate-500';
  if (p >= 70) return GOOD;
  if (p >= 40) return SLATE;
  return 'text-slate-400';
}

function isOverThreshold(reworkRate: number | null | undefined): boolean {
  const p = toPct(reworkRate);
  return p != null && p > REWORK_WARN;
}

// ── Small presentational pieces ──────────────────────────────────────────────

function RollupCard({
  label,
  value,
  sub,
  icon: Icon,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
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
      <span
        className={clsx(
          'text-sm font-medium',
          mono && 'font-mono tabular-nums',
          color ?? 'text-slate-200'
        )}
      >
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
  defaultOpen,
}: {
  card: Scorecard;
  rank?: number;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const tp = card.throughput ?? {};
  const ct = card.cycleTime ?? {};
  const q = card.quality ?? {};
  const au = card.autonomy ?? {};
  const en = card.engagement ?? {};
  const flagged = isOverThreshold(q.reworkRate);

  return (
    <div
      className={clsx(
        'card overflow-hidden p-0 transition-colors',
        flagged && 'ring-1 ring-red-500/30'
      )}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.02] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
      >
        {rank != null && (
          <span className="w-6 shrink-0 font-mono text-sm tabular-nums text-slate-500">
            {rank}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white">{card.name || '—'}</p>
          <p className="truncate text-2xs uppercase tracking-caps text-slate-500">
            {card.role ?? '—'}
          </p>
        </div>
        {/* Volume ALWAYS paired with quality — anti-gaming (FPB Dim 11). */}
        <div className="hidden items-center gap-5 sm:flex">
          <div className="text-right">
            <p className="font-mono text-sm font-semibold tabular-nums text-white">
              {num(tp.weighted)}
            </p>
            <p className="text-2xs text-slate-500">wtd output</p>
          </div>
          <div className="text-right">
            <p className={clsx('font-mono text-sm font-semibold tabular-nums', reworkColor(q.reworkRate))}>
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
        <ChevronDown
          size={16}
          className={clsx('shrink-0 text-slate-500 transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div className="grid gap-5 border-t border-slate-800 bg-surface-950/40 px-4 py-4 md:grid-cols-2">
          <FamilyBlock title="Throughput">
            <Stat label="Categorized" value={num(tp.categorizations)} />
            <Stat label="Approvals" value={num(tp.approvals)} />
            <Stat label="Journal entries" value={num(tp.jes)} />
            <Stat label="Bills" value={num(tp.bills)} />
            <Stat label="Weighted" value={num(tp.weighted)} color="text-emerald-400" />
          </FamilyBlock>

          <FamilyBlock title="Cycle time">
            <Stat
              label="Upload → coded"
              value={hoursStr(ct.uploadToCategorizedHours)}
              color={lowerColor(ct.uploadToCategorizedHours, CYCLE_GOOD_H, CYCLE_WARN_H)}
            />
            <Stat
              label="Coded → approved"
              value={hoursStr(ct.categorizedToApprovedHours)}
              color={lowerColor(ct.categorizedToApprovedHours, APPROVAL_GOOD_H, APPROVAL_WARN_H)}
            />
            <Stat
              label="Approval latency"
              value={hoursStr(ct.approvalLatencyHours)}
              color={lowerColor(ct.approvalLatencyHours, APPROVAL_GOOD_H, APPROVAL_WARN_H)}
            />
          </FamilyBlock>

          <FamilyBlock title="Quality">
            <Stat label="Rework rate" value={pctStr(q.reworkRate)} color={reworkColor(q.reworkRate)} />
            <Stat
              label="Override rate"
              value={pctStr(q.overrideRate)}
              color={overrideColor(q.overrideRate)}
            />
            <Stat label="Exceptions resolved" value={num(q.exceptionsResolved)} />
          </FamilyBlock>

          <FamilyBlock title="Autonomy">
            <Stat label="Human actions" value={num(au.humanActions)} />
            <Stat label="AI actions" value={num(au.aiActions)} />
            <Stat
              label="Autonomy rate"
              value={pctStr(au.autonomyRate)}
              color={autonomyColor(au.autonomyRate)}
            />
          </FamilyBlock>

          <FamilyBlock title="Engagement">
            <Stat label="Active days" value={num(en.activeDays)} />
            <Stat label="Last active" value={relTime(en.lastActiveAt)} mono={false} />
            <Stat label="Open backlog" value={num(en.backlog)} color={backlogColor(en.backlog)} />
          </FamilyBlock>
        </div>
      )}
    </div>
  );
}

// ── Leaderboard (manager-only, quality-gated) ────────────────────────────────

type SortKey = 'rank' | 'composite' | 'rework' | 'autonomy' | 'backlog' | 'name';

function Leaderboard({
  rows,
  cards,
}: {
  rows: LeaderboardRow[];
  cards: Map<string, Scorecard>;
}) {
  const [sortKey, setSortKey] = useState<SortKey>('rank');
  const [asc, setAsc] = useState(true);

  const enriched = useMemo(
    () =>
      rows.map((r) => {
        const c = cards.get(r.userId);
        return {
          ...r,
          reworkRate: c?.quality?.reworkRate ?? null,
          autonomyRate: c?.autonomy?.autonomyRate ?? null,
          backlog: c?.engagement?.backlog ?? null,
        };
      }),
    [rows, cards]
  );

  const sorted = useMemo(() => {
    const dir = asc ? 1 : -1;
    const val = (r: (typeof enriched)[number]): number | string => {
      switch (sortKey) {
        case 'name':
          return r.name?.toLowerCase() ?? '';
        case 'composite':
          return r.compositeScore ?? -Infinity;
        case 'rework':
          return toPct(r.reworkRate) ?? Infinity;
        case 'autonomy':
          return toPct(r.autonomyRate) ?? -Infinity;
        case 'backlog':
          return r.backlog ?? Infinity;
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
      setAsc(k === 'name' || k === 'rank');
    }
  }

  const Header = ({ k, children, align = 'left' }: { k: SortKey; children: React.ReactNode; align?: 'left' | 'right' | 'center' }) => (
    <th
      className={clsx(
        'px-4 py-2.5 text-caption font-medium uppercase tracking-caps text-slate-500',
        align === 'left' && 'text-left',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center'
      )}
    >
      <button
        onClick={() => toggleSort(k)}
        className={clsx(
          'inline-flex items-center gap-1 transition-colors hover:text-slate-300 focus:outline-none',
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
        <h4 className="text-sm font-semibold text-white">Leaderboard</h4>
      </div>
      {/* Anti-gaming framing surfaced to the manager (FPB Dim 11). */}
      <div className="flex items-start gap-2 border-b border-slate-800 bg-surface-950/40 px-4 py-2.5 text-2xs leading-relaxed text-slate-500">
        <Info size={13} className="mt-px shrink-0 text-slate-500" />
        <span>
          Ranked on <span className="text-slate-300">difficulty-weighted</span> output and{' '}
          <span className="text-slate-300">quality-gated</span> — not raw volume. Rework is shown beside
          every score; anyone over {REWORK_WARN}% is flagged for coaching, not celebrated. Metrics inform
          coaching and staffing, never pay or ranking on their own.
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800">
              <Header k="rank">#</Header>
              <Header k="name">Member</Header>
              <Header k="composite" align="right">
                Composite
              </Header>
              <Header k="rework" align="right">
                Rework
              </Header>
              <Header k="autonomy" align="right">
                Autonomy
              </Header>
              <Header k="backlog" align="right">
                Backlog
              </Header>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50">
            {sorted.map((r) => {
              const flagged = isOverThreshold(r.reworkRate);
              return (
                <tr key={r.userId} className={clsx('table-row-hover', flagged && 'bg-red-500/[0.03]')}>
                  <td className="px-4 py-3 font-mono text-sm tabular-nums text-slate-400">{r.rank}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-white">{r.name || '—'}</span>
                      {flagged && (
                        <span className="rounded-full bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-400">
                          quality
                        </span>
                      )}
                    </div>
                    {r.role && (
                      <span className="text-2xs uppercase tracking-caps text-slate-500">{r.role}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-mono font-semibold tabular-nums text-white">
                    {num(r.compositeScore)}
                  </td>
                  <td
                    className={clsx(
                      'px-4 py-3 text-right font-mono tabular-nums',
                      reworkColor(r.reworkRate)
                    )}
                  >
                    {pctStr(r.reworkRate)}
                  </td>
                  <td
                    className={clsx(
                      'px-4 py-3 text-right font-mono tabular-nums',
                      autonomyColor(r.autonomyRate)
                    )}
                  >
                    {pctStr(r.autonomyRate)}
                  </td>
                  <td
                    className={clsx('px-4 py-3 text-right font-mono tabular-nums', backlogColor(r.backlog))}
                  >
                    {num(r.backlog)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Panel ────────────────────────────────────────────────────────────────────

export function PerformancePanel({ scope }: { scope: Scope }) {
  const [period, setPeriod] = useState<PeriodKey>('30d');
  const [cardSort, setCardSort] = useState<'weighted' | 'rework' | 'backlog' | 'name'>('weighted');

  const { data, isLoading, error, refetch } = useQuery<PerfResponse>('/api/team-performance', {
    period,
  });

  const scorecards = useMemo(() => data?.scorecards ?? [], [data]);
  const leaderboard = data?.leaderboard ?? [];
  const team = data?.team ?? null;
  const cardMap = useMemo(() => {
    const m = new Map<string, Scorecard>();
    for (const c of scorecards) m.set(c.userId, c);
    return m;
  }, [scorecards]);

  const isManager = scope === 'team';

  const sortedCards = useMemo(() => {
    const val = (c: Scorecard): number | string => {
      switch (cardSort) {
        case 'name':
          return c.name?.toLowerCase() ?? '';
        case 'rework':
          return toPct(c.quality?.reworkRate) ?? Infinity;
        case 'backlog':
          return c.engagement?.backlog ?? Infinity;
        default:
          return -(c.throughput?.weighted ?? -Infinity);
      }
    };
    return [...scorecards].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (typeof av === 'number' && typeof bv === 'number') return av - bv;
      return String(av).localeCompare(String(bv));
    });
  }, [scorecards, cardSort]);

  return (
    <div className="space-y-6">
      {/* Controls: period selector (7d/30d/QTD/YTD) — FPB Dim 4. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-0.5 rounded-lg border border-slate-800 bg-surface-850 p-0.5">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              className={clsx(
                'rounded-md px-3 py-1 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40',
                period === p.key
                  ? 'bg-brand-500/10 text-emerald-400'
                  : 'text-slate-400 hover:text-slate-200'
              )}
            >
              {p.label}
            </button>
          ))}
        </div>

        {isManager && scorecards.length > 0 && (
          <label className="flex items-center gap-2 text-xs text-slate-500">
            Sort cards
            <select
              value={cardSort}
              onChange={(e) => setCardSort(e.target.value as typeof cardSort)}
              className="input h-8 w-auto py-1 text-xs"
            >
              <option value="weighted">Weighted output</option>
              <option value="rework">Rework rate</option>
              <option value="backlog">Backlog</option>
              <option value="name">Name</option>
            </select>
          </label>
        )}
      </div>

      {/* Privacy boundary made explicit for a self-only viewer (FPB Dim 14/15). */}
      {!isManager && (
        <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-surface-850 px-3.5 py-2.5 text-xs text-slate-400">
          <Lock size={14} className="shrink-0 text-slate-500" />
          You&apos;re viewing your own scorecard. The team leaderboard and peers&apos; scorecards are
          visible to managers only.
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
      ) : scorecards.length === 0 && leaderboard.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={Activity}
            title="No activity logged in this window"
            description="Once the team takes action in this period — categorizing, approving, posting — their performance appears here. If this stays empty, action logging may not be wired for every route."
          />
        </div>
      ) : (
        <>
          {/* Team roll-up cards — manager lens only. */}
          {isManager && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <RollupCard
                label="Weighted throughput"
                value={num(team?.weightedThroughput ?? team?.totalThroughput)}
                sub="difficulty-weighted output"
                icon={Layers}
                accent="text-emerald-400"
              />
              <RollupCard
                label="Avg cycle time"
                value={hoursStr(team?.avgCycleTimeHours)}
                sub="upload → approved"
                icon={Clock}
              />
              <RollupCard
                label="Team autonomy"
                value={pctStr(team?.autonomyRate)}
                sub="AI actions at auto tier"
                icon={Gauge}
                accent={autonomyColor(team?.autonomyRate)}
              />
              <RollupCard
                label="Open backlog"
                value={num(team?.openBacklog)}
                sub="unresolved items"
                icon={ShieldCheck}
                accent={backlogColor(team?.openBacklog)}
              />
            </div>
          )}

          {/* Quality-gated leaderboard — manager only. */}
          {isManager && leaderboard.length > 0 && (
            <Leaderboard rows={leaderboard} cards={cardMap} />
          )}

          {/* Per-person scorecards (expandable). Self-viewer sees only their own. */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-semibold text-white">
                {isManager ? 'Scorecards' : 'Your scorecard'}
              </h4>
              {isManager && (
                <span className="font-mono text-2xs tabular-nums text-slate-500">
                  {scorecards.length}
                </span>
              )}
            </div>
            {sortedCards.length === 0 ? (
              <div className="card">
                <EmptyState
                  icon={Activity}
                  title="No scorecard yet"
                  description="No logged activity in this window."
                />
              </div>
            ) : (
              <div className="space-y-2">
                {sortedCards.map((c, i) => (
                  <ScorecardCard
                    key={c.userId}
                    card={c}
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
