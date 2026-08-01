'use client';

import { Fragment, useMemo, useState, useCallback, useEffect } from 'react';
import Link from 'next/link';
import {
  Loader2,
  AlertCircle,
  Lock,
  Clock,
  Circle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  RefreshCw,
  ArrowUpDown,
  ShieldAlert,
  Landmark,
  Inbox,
  Flag,
  CalendarCheck,
} from 'lucide-react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { useQuery } from '@/hooks';

// ── Types (mirror /api/close-status response) ──────────────────────────────────

type Readiness = 'ready' | 'at_risk' | 'blocked' | 'closed' | 'no_period';
type BankRecState = 'complete' | 'incomplete' | 'none';
type PeriodStatus = 'OPEN' | 'SOFT_CLOSE' | 'HARD_CLOSE' | 'NO_PERIOD';
type Tier = 'auto' | 'review' | 'escalate';
type LeakageKind = 'uncoded_bank' | 'unposted_receipt' | 'unpaid_bill';

interface Blocker {
  severity: 'hard' | 'soft';
  label: string;
}
interface EntityCloseStatus {
  locationId: string;
  name: string;
  shortCode: string;
  periodStatus: PeriodStatus;
  closedAt: string | null;
  bankRec: BankRecState;
  bankRecTotal: number;
  bankRecReconciled: number;
  leakageAtRiskCents: number;
  leakageItems: number;
  leakageTier: Tier | null;
  leakageByKind: Record<LeakageKind, number>;
  openExceptions: number;
  exceptionAtRiskCents: number;
  flaggedItems: number;
  readiness: Readiness;
  blockers: Blocker[];
}
interface Summary {
  totalEntities: number;
  ready: number;
  atRisk: number;
  blocked: number;
  closed: number;
  noPeriod: number;
  closeReady: number;
  totalLeakageAtRiskCents: number;
  blockingLeakageAtRiskCents: number;
  totalOpenExceptions: number;
  totalFlagged: number;
  entitiesReconciled: number;
}
interface CloseStatusResponse {
  period: { year: number; month: number; key: string; label: string };
  generatedAt: string;
  summary: Summary;
  entities: EntityCloseStatus[];
}

// ── Config ─────────────────────────────────────────────────────────────────────

const READINESS: Record<Readiness, { label: string; dot: string; text: string; ring: string }> = {
  blocked: { label: 'Blocked', dot: 'bg-red-500', text: 'text-red-300', ring: 'border-red-500/30 bg-red-500/10' },
  at_risk: { label: 'At risk', dot: 'bg-amber-500', text: 'text-amber-300', ring: 'border-amber-500/30 bg-amber-500/10' },
  ready: { label: 'Ready', dot: 'bg-emerald-500', text: 'text-emerald-300', ring: 'border-emerald-500/30 bg-emerald-500/10' },
  closed: { label: 'Closed', dot: 'bg-emerald-500', text: 'text-emerald-300', ring: 'border-emerald-500/30 bg-emerald-500/10' },
  no_period: { label: 'No period', dot: 'bg-slate-600', text: 'text-slate-400', ring: 'border-slate-600/30 bg-slate-700/10' },
};

const PERIOD_BADGE: Record<PeriodStatus, { label: string; cls: string; icon: typeof Lock }> = {
  OPEN: { label: 'Open', cls: 'bg-blue-500/15 text-blue-300 border-blue-500/25', icon: Circle },
  SOFT_CLOSE: { label: 'Soft close', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/25', icon: Clock },
  HARD_CLOSE: { label: 'Hard close', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25', icon: Lock },
  NO_PERIOD: { label: 'No period', cls: 'bg-slate-600/15 text-slate-400 border-slate-600/25', icon: AlertCircle },
};

const BANKREC: Record<BankRecState, { label: string; cls: string }> = {
  complete: { label: 'Reconciled', cls: 'text-emerald-400' },
  incomplete: { label: 'Incomplete', cls: 'text-red-400' },
  none: { label: 'Not started', cls: 'text-slate-500' },
};

const KIND_LABEL: Record<LeakageKind, string> = {
  uncoded_bank: 'Uncoded bank/card',
  unposted_receipt: 'Unposted receipts',
  unpaid_bill: 'Unposted bills',
};

type SortKey = 'priority' | 'name' | 'leakage' | 'exceptions' | 'flagged';

// ── Small presentational pieces ────────────────────────────────────────────────

function ReadinessPill({ r }: { r: Readiness }) {
  const c = READINESS[r];
  return (
    <span className={clsx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium', c.ring, c.text)}>
      <span className={clsx('h-1.5 w-1.5 rounded-full', c.dot)} />
      {c.label}
    </span>
  );
}

function PeriodBadge({ s }: { s: PeriodStatus }) {
  const b = PERIOD_BADGE[s];
  const Icon = b.icon;
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium', b.cls)}>
      <Icon size={11} />
      {b.label}
    </span>
  );
}

interface StatTileProps {
  label: string;
  value: string;
  hint?: string;
  icon: typeof CalendarCheck;
  tone?: 'default' | 'danger' | 'warn' | 'good';
}
function StatTile({ label, value, hint, icon: Icon, tone = 'default' }: StatTileProps) {
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

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const sec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.round(min / 60)}h ago`;
}

// ── Main board ──────────────────────────────────────────────────────────────────

export function CloseStatusBoard() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1); // 1-12
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('priority');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [refreshKey, setRefreshKey] = useState(0);
  const [, forceTick] = useState(0);

  const { data, isLoading, error, refetch } = useQuery<CloseStatusResponse>(
    `/api/close-status?year=${year}&month=${month}`,
    undefined,
    { key: String(refreshKey), refetchInterval: 90_000 }
  );

  // Keep the "updated Xs ago" label honest between fetches.
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  const stepMonth = useCallback((delta: number) => {
    setExpanded(null);
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
    if (sortKey === 'priority') return rows; // server already ranks worst-first
    const dir = sortDir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'name') cmp = a.name.localeCompare(b.name);
      else if (sortKey === 'leakage') cmp = a.leakageAtRiskCents - b.leakageAtRiskCents;
      else if (sortKey === 'exceptions') cmp = a.openExceptions - b.openExceptions;
      else if (sortKey === 'flagged') cmp = a.flaggedItems - b.flaggedItems;
      return cmp * dir;
    });
    return rows;
  }, [data?.entities, sortKey, sortDir]);

  const summary = data?.summary;
  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1;

  return (
    <div className="space-y-5">
      {/* Period selector + refresh */}
      <div className="flex flex-wrap items-center justify-between gap-3">
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

        <div className="flex items-center gap-3">
          {data && (
            <span className="text-[11px] text-slate-500">Updated {relativeTime(data.generatedAt)}</span>
          )}
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
      ) : !summary || summary.totalEntities === 0 ? (
        <div className="card p-12 text-center">
          <CalendarCheck className="mx-auto mb-3 h-8 w-8 text-slate-600" />
          <p className="text-sm font-medium text-slate-300">No entities to report on</p>
          <p className="mt-1 text-xs text-slate-500">
            No active companies were found for this period. Create entities and fiscal periods to light up the board.
          </p>
        </div>
      ) : (
        <>
          {/* Portfolio roll-up */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            <StatTile
              label="Close-ready"
              value={`${summary.closeReady}/${summary.totalEntities}`}
              hint="ready or closed"
              icon={CheckCircle2}
              tone="good"
            />
            <StatTile label="Blocked" value={String(summary.blocked)} hint="hard blocker present" icon={ShieldAlert} tone={summary.blocked > 0 ? 'danger' : 'default'} />
            <StatTile label="At risk" value={String(summary.atRisk)} hint="soft blockers" icon={Clock} tone={summary.atRisk > 0 ? 'warn' : 'default'} />
            <StatTile
              label="Not in the GL"
              value={formatMoney(summary.totalLeakageAtRiskCents, { compact: true })}
              hint={summary.blockingLeakageAtRiskCents > 0 ? `${formatMoney(summary.blockingLeakageAtRiskCents, { compact: true })} blocking` : 'uncoded / unposted'}
              icon={Landmark}
              tone={summary.blockingLeakageAtRiskCents > 0 ? 'danger' : summary.totalLeakageAtRiskCents > 0 ? 'warn' : 'default'}
            />
            <StatTile label="Open exceptions" value={String(summary.totalOpenExceptions)} hint="review queue" icon={Inbox} tone={summary.totalOpenExceptions > 0 ? 'warn' : 'default'} />
            <StatTile label="Bank reconciled" value={`${summary.entitiesReconciled}/${summary.totalEntities}`} hint="entities fully tied" icon={CheckCircle2} tone="default" />
          </div>

          {/* Entity matrix */}
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-800/60 text-left text-[11px] text-slate-500">
                    <th className="px-4 py-2.5 font-medium">
                      <SortHeader label="Entity" active={sortKey === 'name'} dir={sortDir} onClick={() => setSort('name')} />
                    </th>
                    <th className="px-3 py-2.5 font-medium">Period</th>
                    <th className="px-3 py-2.5 font-medium">Bank rec</th>
                    <th className="px-3 py-2.5 text-right font-medium">
                      <SortHeader label="Not in GL" active={sortKey === 'leakage'} dir={sortDir} onClick={() => setSort('leakage')} align="right" />
                    </th>
                    <th className="px-3 py-2.5 text-right font-medium">
                      <SortHeader label="Exceptions" active={sortKey === 'exceptions'} dir={sortDir} onClick={() => setSort('exceptions')} align="right" />
                    </th>
                    <th className="px-3 py-2.5 text-right font-medium">
                      <SortHeader label="Flagged" active={sortKey === 'flagged'} dir={sortDir} onClick={() => setSort('flagged')} align="right" />
                    </th>
                    <th className="px-4 py-2.5 text-right font-medium">
                      <SortHeader label="Readiness" active={sortKey === 'priority'} dir={sortDir} onClick={() => setSort('priority')} align="right" />
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/40">
                  {entities.map((e) => {
                    const isOpen = expanded === e.locationId;
                    const bank = BANKREC[e.bankRec];
                    return (
                      <Fragment key={e.locationId}>
                        <tr
                          onClick={() => setExpanded(isOpen ? null : e.locationId)}
                          className="cursor-pointer text-slate-300 transition-colors hover:bg-slate-800/30"
                        >
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2.5">
                              {isOpen ? <ChevronDown size={14} className="text-slate-500" /> : <ChevronRight size={14} className="text-slate-600" />}
                              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-slate-700/70 font-mono text-[9px] text-slate-300">
                                {e.shortCode}
                              </span>
                              <span className="font-medium text-slate-100">{e.name}</span>
                            </div>
                          </td>
                          <td className="px-3 py-3">
                            <PeriodBadge s={e.periodStatus} />
                          </td>
                          <td className="px-3 py-3">
                            <span className={clsx('text-xs font-medium', bank.cls)}>
                              {bank.label}
                              {e.bankRec === 'incomplete' && (
                                <span className="ml-1 font-mono text-[10px] text-slate-500">{e.bankRecReconciled}/{e.bankRecTotal}</span>
                              )}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-right font-mono tabular-nums">
                            {e.leakageAtRiskCents > 0 ? (
                              <span className={e.leakageTier === 'escalate' ? 'text-red-400' : 'text-amber-400'}>
                                {formatMoney(e.leakageAtRiskCents, { compact: true })}
                              </span>
                            ) : (
                              <span className="text-slate-600">$0</span>
                            )}
                          </td>
                          <td className="px-3 py-3 text-right font-mono tabular-nums">
                            {e.openExceptions > 0 ? <span className="text-amber-400">{e.openExceptions}</span> : <span className="text-slate-600">0</span>}
                          </td>
                          <td className="px-3 py-3 text-right font-mono tabular-nums">
                            {e.flaggedItems > 0 ? <span className="text-amber-400">{e.flaggedItems}</span> : <span className="text-slate-600">0</span>}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <ReadinessPill r={e.readiness} />
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="bg-surface-950/60">
                            <td colSpan={7} className="px-4 py-4">
                              <EntityDetail e={e} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <p className="text-[11px] leading-relaxed text-slate-600">
            Period status and bank reconciliation reflect the selected fiscal month. &ldquo;Not in the GL&rdquo;
            (uncategorized/unposted), open exceptions, and flagged items reflect current live state (aged activity
            blocks a clean close regardless of the month it landed). This board asserts no status of its own — every
            cell is derived from the books.
          </p>
        </>
      )}
    </div>
  );
}

// ── Sort header ─────────────────────────────────────────────────────────────────

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

// ── Expanded per-entity detail ──────────────────────────────────────────────────

function EntityDetail({ e }: { e: EntityCloseStatus }) {
  const hardBlockers = e.blockers.filter((b) => b.severity === 'hard');
  const softBlockers = e.blockers.filter((b) => b.severity === 'soft');
  const kinds = (Object.keys(e.leakageByKind) as LeakageKind[]).filter((k) => e.leakageByKind[k] > 0);

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      {/* What's blocking */}
      <div>
        <p className="mb-2 text-xs font-semibold text-white">What&apos;s blocking a clean close</p>
        {e.blockers.length === 0 ? (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-300">
            <CheckCircle2 size={14} />
            {e.periodStatus === 'HARD_CLOSE' ? 'Period is hard-closed and locked.' : 'Nothing blocking — this entity is close-ready.'}
          </div>
        ) : (
          <ul className="space-y-1.5">
            {hardBlockers.map((b, i) => (
              <li key={`h-${i}`} className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-200">
                <ShieldAlert size={13} className="mt-0.5 shrink-0 text-red-400" />
                {b.label}
              </li>
            ))}
            {softBlockers.map((b, i) => (
              <li key={`s-${i}`} className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
                <Flag size={13} className="mt-0.5 shrink-0 text-amber-400" />
                {b.label}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Signal breakdown + drill-in links */}
      <div className="space-y-3">
        <p className="text-xs font-semibold text-white">Signals</p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <SignalRow label="Not in the GL" value={formatMoney(e.leakageAtRiskCents)} sub={`${e.leakageItems} item(s)`} tone={e.leakageTier === 'escalate' ? 'danger' : e.leakageAtRiskCents > 0 ? 'warn' : 'muted'} />
          <SignalRow label="Open exceptions" value={String(e.openExceptions)} sub={e.exceptionAtRiskCents > 0 ? `${formatMoney(e.exceptionAtRiskCents)} at risk` : 'review queue'} tone={e.openExceptions > 0 ? 'warn' : 'muted'} />
          <SignalRow label="Flagged items" value={String(e.flaggedItems)} sub="bank / receipts / bills" tone={e.flaggedItems > 0 ? 'warn' : 'muted'} />
          <SignalRow
            label="Bank reconciliation"
            value={BANKREC[e.bankRec].label}
            sub={e.bankRecTotal > 0 ? `${e.bankRecReconciled}/${e.bankRecTotal} accounts` : 'no run yet'}
            tone={e.bankRec === 'complete' ? 'good' : e.bankRec === 'incomplete' ? 'danger' : 'muted'}
          />
        </dl>

        {kinds.length > 0 && (
          <div className="rounded-lg border border-slate-800 bg-surface-900 p-3">
            <p className="mb-1.5 text-[11px] font-medium text-slate-400">Uncategorized / unposted by type</p>
            <ul className="space-y-1">
              {kinds.map((k) => (
                <li key={k} className="flex items-center justify-between text-[11px]">
                  <span className="text-slate-400">{KIND_LABEL[k]}</span>
                  <span className="font-mono tabular-nums text-slate-200">{formatMoney(e.leakageByKind[k])}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap gap-2 pt-1">
          <DrillLink href="/exceptions" label="Exception queue" />
          <DrillLink href="/bank-feed" label="Bank feed" />
          <DrillLink href="/close" label="Close checklist" />
        </div>
      </div>
    </div>
  );
}

function SignalRow({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: 'good' | 'warn' | 'danger' | 'muted' }) {
  const valTone =
    tone === 'danger' ? 'text-red-400' : tone === 'warn' ? 'text-amber-400' : tone === 'good' ? 'text-emerald-400' : 'text-slate-300';
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className={clsx('mt-0.5 font-mono text-sm font-semibold tabular-nums', valTone)}>{value}</dd>
      <dd className="text-[10px] text-slate-600">{sub}</dd>
    </div>
  );
}

function DrillLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 rounded-md border border-slate-800 bg-surface-900 px-2.5 py-1 text-[11px] text-slate-300 hover:border-emerald-500/40 hover:text-white"
    >
      {label}
      <ChevronRight size={11} />
    </Link>
  );
}
